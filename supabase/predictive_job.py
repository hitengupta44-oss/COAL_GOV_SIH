"""
Predictive compliance -- which pending obligations are likely to be missed.

WHY THIS EXISTS
---------------
risk_scoring_job.py looks backwards: it flags what has already gone wrong.
The problem statement asks for predictive alerts, so this job looks
forward. For every compliance obligation still Pending it estimates the
probability that it will be missed, explains the estimate, and raises an
alert while there is still time to act.

    pip install -r requirements.txt
    python predictive_job.py

Run it after risk_scoring_job.py, daily (see .github/workflows).

THE MODEL
---------
Logistic regression (scikit-learn), deliberately. Coefficients can be read
and every prediction decomposes into per-factor contributions, so the
dashboard can say WHY an item is at risk -- a black-box score gives a mine
official nothing to act on, and a regulator nothing to audit.

Training rows: obligations whose outcome is known.
  label 1 = missed    (status Overdue, or Completed after its due date)
  label 0 = on time   (Completed on or before its due date)
Prediction rows: obligations still Pending.

Features, all computed from data already on the platform:
  * the mine's own miss rate on its other obligations        (track record)
  * this requirement's miss rate at other mines              (how hard it is)
  * category and frequency of the requirement
  * underground / opencast / mixed
  * open High/Critical inspection findings at the mine        (site under strain)
  * fatal accidents on record, overdue grievances, lapsed contractor documents

The two rates are computed leave-one-out for training rows (a row's own
outcome is excluded from its own feature) and smoothed toward the national
average, so a mine with three obligations is not scored as 0% or 100%.

HONESTY NOTE
------------
The model is only as real as the history it learns from. The compliance
statuses loaded by seed_compliance_tracking.py are synthetic, generated
from a hidden per-mine "health" score -- so on seed data the model will
largely rediscover that score, and the cross-validated AUC it prints will
look better than it would on real records. The pipeline, the validation
and the explanations are real; point it at real compliance history and
the numbers become meaningful. The AUC is printed and stored with every
prediction so nobody has to take the quality on trust.

OUTPUT
------
  compliance_predictions   one row per pending obligation (migration 09)
  ai_risk_flags            'Predicted Non-Compliance' per mine with 3+ likely misses
                           likely misses -- answered through the same
                           respond/dispute workflow as every other flag
  alerts                   to the mine official for high-probability items
                           falling due within 14 days
"""

import datetime as dt
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from supabase import create_client

from credentials import get_supabase_credentials

MODEL_VERSION = "logreg-v1"
PRIOR_WEIGHT = 5          # smoothing strength for the two rate features
ALERT_WINDOW_DAYS = 14    # early warnings for items due this soon
FLAG_MIN_ITEMS = 3        # likely misses before a mine-level flag is raised

# What counts as "likely to be missed" is set relative to how often
# obligations are missed overall: at least twice the base rate, and never
# below an even chance (or above 70%). A fixed cut-off breaks as soon as
# the history changes -- more on-time records lower every probability, and
# a 70% bar that suited one dataset silences every warning on the next.
def likely_threshold(base_rate):
    return round(min(0.70, max(0.50, 2 * base_rate)), 2)


TODAY = dt.date.today()


def fetch_all(sb, build, page_size=1000):
    out, page = [], 0
    while True:
        chunk = build().range(page * page_size, page * page_size + page_size - 1).execute().data or []
        out.extend(chunk)
        if len(chunk) < page_size:
            return out
        page += 1


def risk_band(p):
    return "Critical" if p >= 0.7 else "High" if p >= 0.5 else "Medium" if p >= 0.3 else "Low"


# ------------------------------------------------------------------ data
def load(sb):
    ct = pd.DataFrame(fetch_all(sb, lambda: sb.table("compliance_tracking").select(
        "tracking_id, mine_id, item_id, due_date, completed_date, status")))
    items = pd.DataFrame(sb.table("statutory_compliance_items").select(
        "item_id, category, frequency, requirement_summary").execute().data or [])
    mines = pd.DataFrame(fetch_all(sb, lambda: sb.table("mines").select("mine_id, mine_name, mine_type")))

    def per_mine(rows, name):
        s = pd.Series([r["mine_id"] for r in rows if r.get("mine_id")], dtype="object")
        return s.value_counts().rename(name)

    findings = fetch_all(sb, lambda: sb.table("geo_inspections").select("mine_id").in_(
        "severity", ["High", "Critical"]).neq("corrective_action_status", "Closed"))
    fatal = fetch_all(sb, lambda: sb.table("accidents").select("mine_id").eq("severity", "Fatal").not_.is_("mine_id", "null"))
    try:
        grv = fetch_all(sb, lambda: sb.table("grievance_status_view").select("mine_id").eq("is_overdue", True))
    except Exception:
        grv = []
    try:
        docs = fetch_all(sb, lambda: sb.table("contractor_compliance_view").select("mine_id").eq(
            "computed_status", "Expired"))
    except Exception:
        docs = []

    site = pd.concat([per_mine(findings, "open_findings"), per_mine(fatal, "fatal_accidents"),
                      per_mine(grv, "overdue_grievances"), per_mine(docs, "lapsed_documents")], axis=1).fillna(0)
    return ct, items, mines, site


# ------------------------------------------------------------------ features
def build_features(ct, items, mines, site):
    df = ct.merge(items, on="item_id", how="left").merge(mines, on="mine_id", how="left")
    df = df.merge(site, left_on="mine_id", right_index=True, how="left")
    for c in ["open_findings", "fatal_accidents", "overdue_grievances", "lapsed_documents"]:
        df[c] = df[c].fillna(0)

    due = pd.to_datetime(df["due_date"], errors="coerce")
    done = pd.to_datetime(df["completed_date"], errors="coerce")
    df["label"] = np.nan
    df.loc[df["status"] == "Overdue", "label"] = 1
    df.loc[(df["status"] == "Completed") & (done > due), "label"] = 1
    df.loc[(df["status"] == "Completed") & ((done <= due) | done.isna()), "label"] = 0

    known = df["label"].notna()
    global_rate = df.loc[known, "label"].mean() if known.any() else 0.2

    # Leave-one-out, smoothed rates. For a training row its own outcome is
    # subtracted out; pending rows have no outcome, so nothing to subtract.
    for key, name in [("mine_id", "mine_miss_rate"), ("item_id", "item_miss_rate")]:
        grp = df[known].groupby(key)["label"].agg(["sum", "count"])
        s = df[key].map(grp["sum"]).fillna(0)
        n = df[key].map(grp["count"]).fillna(0)
        own = df["label"].fillna(0).where(known, 0)
        own_n = known.astype(int)
        df[name] = (s - own + PRIOR_WEIGHT * global_rate) / (n - own_n + PRIOR_WEIGHT)

    cats = pd.get_dummies(df["category"].fillna("Unknown"), prefix="cat", dtype=float)
    freq = pd.get_dummies(df["frequency"].fillna("Unknown"), prefix="freq", dtype=float)
    mtype = pd.get_dummies(df["mine_type"].fillna("Unknown"), prefix="type", dtype=float)
    numeric = pd.DataFrame({
        "mine_miss_rate": df["mine_miss_rate"],
        "item_miss_rate": df["item_miss_rate"],
        "open_findings": np.log1p(df["open_findings"]),
        "fatal_accidents": np.log1p(df["fatal_accidents"]),
        "overdue_grievances": np.log1p(df["overdue_grievances"]),
        "lapsed_documents": np.log1p(df["lapsed_documents"]),
    })
    X = pd.concat([numeric, cats, freq, mtype], axis=1)
    return df, X


def describe(feature, raw):
    """Plain-language reason for a positive contribution."""
    if feature == "mine_miss_rate":
        return f"This mine misses {round(raw['mine_miss_rate'] * 100)}% of its other obligations"
    if feature == "item_miss_rate":
        return f"Missed at {round(raw['item_miss_rate'] * 100)}% of mines that carry it"
    if feature == "open_findings":
        return f"{int(raw['open_findings'])} High/Critical inspection finding(s) still open"
    if feature == "fatal_accidents":
        return f"{int(raw['fatal_accidents'])} fatal accident(s) on record"
    if feature == "overdue_grievances":
        return f"{int(raw['overdue_grievances'])} grievance(s) past their deadline"
    if feature == "lapsed_documents":
        return f"{int(raw['lapsed_documents'])} lapsed contractor document(s)"
    if feature.startswith("cat_"):
        return f"{feature[4:]} obligations are missed more often"
    if feature.startswith("freq_"):
        return f"{feature[5:]} obligations are missed more often"
    if feature.startswith("type_"):
        return {"UG": "Underground mine", "OC": "Opencast mine"}.get(feature[5:], f"{feature[5:]} mine")
    return feature


# ------------------------------------------------------------------ main
def main():
    url, key = get_supabase_credentials()
    sb = create_client(url, key)

    print("Loading compliance history...")
    ct, items, mines, site = load(sb)
    if ct.empty:
        print("No compliance_tracking rows. Run seed_compliance_tracking.py first.")
        return
    df, X = build_features(ct, items, mines, site)

    train = df["label"].notna()
    pending = df["status"] == "Pending"
    y = df.loc[train, "label"].astype(int)
    print(f"  {train.sum():,} obligations with a known outcome ({y.mean():.0%} missed), "
          f"{pending.sum():,} pending to score")
    if y.nunique() < 2 or train.sum() < 50:
        print("Not enough outcome history to train on yet.")
        return

    model = make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000, C=0.5))

    # Honest out-of-sample quality: 5-fold cross-validated AUC, alongside a
    # naive baseline (the mine's own miss rate alone). If the model does not
    # beat the baseline, say so.
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=7)
    oof = cross_val_predict(model, X[train], y, cv=cv, method="predict_proba")[:, 1]
    auc = roc_auc_score(y, oof)
    base = roc_auc_score(y, df.loc[train, "mine_miss_rate"])
    print(f"  cross-validated AUC {auc:.3f} (baseline, mine track record alone: {base:.3f})")
    threshold = likely_threshold(float(y.mean()))
    print(f"  'likely to be missed' threshold: {threshold:.0%} (base miss rate {y.mean():.0%})")

    model.fit(X[train], y)
    scaler, lr = model.named_steps["standardscaler"], model.named_steps["logisticregression"]

    Xp = X[pending]
    if Xp.empty:
        print("Nothing pending to score.")
        return
    probs = model.predict_proba(Xp)[:, 1]

    # Per-feature contribution to the log-odds, relative to an average
    # obligation. Positive = pushes this item towards being missed.
    z = (Xp.values - scaler.mean_) / np.where(scaler.scale_ == 0, 1, scaler.scale_)
    contrib = z * lr.coef_[0]
    cols = list(X.columns)

    now = dt.datetime.now(dt.timezone.utc).isoformat()
    rows = []
    for i, (idx, rec) in enumerate(df[pending].iterrows()):
        order = np.argsort(-contrib[i])
        factors = []
        for j in order[:3]:
            if contrib[i, j] <= 0.05:
                break
            factors.append({"factor": describe(cols[j], rec), "weight": round(float(contrib[i, j]), 3)})
        p = float(probs[i])
        rows.append({
            "tracking_id": rec["tracking_id"], "mine_id": rec["mine_id"],
            "probability": round(p, 4), "risk_band": risk_band(p), "top_factors": factors,
            "model_version": MODEL_VERSION, "model_auc": round(float(auc), 4), "generated_at": now,
        })

    print(f"Writing {len(rows):,} predictions...")
    for i in range(0, len(rows), 500):
        sb.table("compliance_predictions").upsert(rows[i:i + 500], on_conflict="tracking_id").execute()

    # Predictions for items that are no longer pending are removed.
    live = {r["tracking_id"] for r in rows}
    old = fetch_all(sb, lambda: sb.table("compliance_predictions").select("tracking_id"))
    stale = [r["tracking_id"] for r in old if r["tracking_id"] not in live]
    for i in range(0, len(stale), 200):
        sb.table("compliance_predictions").delete().in_("tracking_id", stale[i:i + 200]).execute()

    pred = pd.DataFrame(rows).merge(df[pending][["tracking_id", "due_date", "requirement_summary", "mine_name"]],
                                    on="tracking_id")
    print(pred["risk_band"].value_counts().to_string())

    raise_alerts(sb, pred, threshold)
    raise_flags(sb, pred, auc, threshold)


def raise_alerts(sb, pred, threshold):
    """Early warning: likely misses falling due soon, addressed to the mine."""
    due = pd.to_datetime(pred["due_date"], errors="coerce").dt.date
    soon = pred[(pred["probability"] >= threshold) &
                (due <= TODAY + dt.timedelta(days=ALERT_WINDOW_DAYS))]
    existing = {r["source_id"] for r in fetch_all(sb, lambda: sb.table("alerts").select("source_id").eq(
        "source_table", "compliance_predictions").in_("status", ["Open", "Acknowledged"]))}

    new = []
    for _, r in soon.iterrows():
        if r["tracking_id"] in existing:
            continue
        reasons = "; ".join(f["factor"] for f in r["top_factors"]) or "pattern at this mine"
        new.append({
            "recipient_role": "mine_official", "mine_id": r["mine_id"], "category": "prediction",
            "severity": "High", "title": f"{r['mine_name']}: likely to miss — {r['requirement_summary'][:80]}",
            "body": (f"Due {r['due_date']}. Estimated {round(r['probability'] * 100)}% chance of being missed "
                     f"based on: {reasons}. Act now to avoid an overdue statutory item."),
            "source_table": "compliance_predictions", "source_id": r["tracking_id"], "due_date": r["due_date"],
        })
    for i in range(0, len(new), 500):
        sb.table("alerts").insert(new[i:i + 500]).execute()

    # Early warnings whose item is no longer at risk (done, or re-scored
    # lower) close themselves.
    keep = set(soon["tracking_id"])
    close = [s for s in existing if s not in keep]
    for i in range(0, len(close), 200):
        sb.table("alerts").update({"status": "Resolved"}).eq("source_table", "compliance_predictions").in_(
            "source_id", close[i:i + 200]).in_("status", ["Open", "Acknowledged"]).execute()
    print(f"Early-warning alerts: {len(new)} raised, {len(close)} closed")


def raise_flags(sb, pred, auc, threshold):
    """One mine-level finding where several obligations look likely to slip.
    Mine responses on existing flags are preserved, as in risk_scoring_job."""
    likely = pred[pred["probability"] >= threshold]
    per_mine = likely.groupby("mine_id").agg(n=("tracking_id", "size"), mean_p=("probability", "mean"),
                                             sample=("requirement_summary", lambda s: list(s)[:3]))
    per_mine = per_mine[per_mine["n"] >= FLAG_MIN_ITEMS]

    existing = {r["mine_id"]: r for r in fetch_all(sb, lambda: sb.table("ai_risk_flags").select(
        "flag_id, mine_id, response_status").eq("flag_type", "Predicted Non-Compliance"))}

    inserted = updated = removed = 0
    for mine_id, r in per_mine.iterrows():
        explanation = (f"{int(r['n'])} pending obligations are predicted likely to be missed "
                       f"(average {round(r['mean_p'] * 100)}%), e.g. {'; '.join(r['sample'])}. "
                       f"Model cross-validated AUC {auc:.2f}.")
        # Scored by the model's own average probability, not inflated by the
        # item count: a forecast should not outrank a breach that has
        # already happened (those score up to 1.0).
        score = float(round(min(0.9, r["mean_p"]), 2))
        row = {"risk_score": score, "explanation": explanation, "model_used": MODEL_VERSION}
        if mine_id in existing:
            sb.table("ai_risk_flags").update(row).eq("flag_id", existing[mine_id]["flag_id"]).execute()
            updated += 1
        else:
            sb.table("ai_risk_flags").insert({**row, "mine_id": mine_id,
                                              "flag_type": "Predicted Non-Compliance"}).execute()
            inserted += 1

    for mine_id, f in existing.items():
        if mine_id not in per_mine.index and (f.get("response_status") or "Open") == "Open":
            sb.table("ai_risk_flags").delete().eq("flag_id", f["flag_id"]).execute()
            removed += 1
    print(f"Predicted Non-Compliance flags: {inserted} new, {updated} refreshed, {removed} withdrawn")


if __name__ == "__main__":
    main()
