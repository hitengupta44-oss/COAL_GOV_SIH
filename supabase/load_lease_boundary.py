"""
Attach a surveyed lease boundary from a KML file to a mine.

    python load_lease_boundary.py path/to/boundary.kml "MINE NAME"

Lease-boundary KMLs are attached to forest-clearance and EC proposals on
PARIVESH (parivesh.nic.in / forestsclearance.nic.in). The script takes the
polygon whose name mentions the lease, or failing that the largest polygon
in the file, and stores it in mine_boundaries (migration 12). From then on
that mine's geo-fence is the lease itself, with 250 m allowed for GPS
error, instead of a circle around the mine's point.

It refuses a boundary that lies more than 25 km from the mine's recorded
position: that almost always means the KML belongs to another mine.
"""

import math
import sys
import xml.etree.ElementTree as ET

from supabase import create_client

from credentials import get_supabase_credentials

NS = {"k": "http://www.opengis.net/kml/2.2"}


def polygons(path):
    root = ET.parse(path).getroot()
    for pm in root.iter("{http://www.opengis.net/kml/2.2}Placemark"):
        name = (pm.findtext("k:name", default="", namespaces=NS) or "").strip()
        for c in pm.iterfind(".//k:Polygon/k:outerBoundaryIs/k:LinearRing/k:coordinates", NS):
            pts = []
            for tok in c.text.split():
                lon, lat = tok.split(",")[:2]
                pts.append([round(float(lat), 7), round(float(lon), 7)])
            if len(pts) >= 3:
                if pts[0] != pts[-1]:
                    pts.append(pts[0])
                yield name, pts


def area_ha(ring):
    lat0 = sum(p[0] for p in ring) / len(ring)
    k = math.cos(math.radians(lat0))
    xy = [(p[1] * 111320 * k, p[0] * 110540) for p in ring]
    a = sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(xy, xy[1:]))
    return abs(a) / 2 / 10000


def km(a, b):
    p = math.pi / 180
    h = math.sin((b[0] - a[0]) * p / 2) ** 2 + math.cos(a[0] * p) * math.cos(b[0] * p) * math.sin((b[1] - a[1]) * p / 2) ** 2
    return 12742 * math.asin(math.sqrt(h))


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    path, mine_name = sys.argv[1], sys.argv[2]
    found = list(polygons(path))
    if not found:
        raise SystemExit("No polygon found in the KML.")
    lease = [f for f in found if "lease" in f[0].lower()]
    name, ring = max(lease or found, key=lambda f: area_ha(f[1]))

    url, key = get_supabase_credentials()
    sb = create_client(url, key)
    rows = sb.table("mines").select("mine_id, mine_name, latitude, longitude").ilike(
        "mine_name", mine_name).execute().data or []
    if len(rows) != 1:
        raise SystemExit(f"{len(rows)} mines match {mine_name!r}; give the exact name.")
    mine = rows[0]
    centre = (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring))
    if mine["latitude"] is not None:
        d = km(centre, (float(mine["latitude"]), float(mine["longitude"])))
        if d > 25:
            raise SystemExit(f"The boundary is {d:.0f} km from {mine['mine_name']}'s recorded position. "
                             "Check that the KML belongs to this mine.")
    sb.table("mine_boundaries").upsert({
        "mine_id": mine["mine_id"], "boundary": ring, "boundary_type": "Surveyed lease polygon",
        "source": f"KML: {path.split('/')[-1]} ({name})", "area_ha": round(area_ha(ring), 2),
    }, on_conflict="mine_id").execute()
    print(f"Stored '{name}' ({len(ring) - 1} corners, {area_ha(ring):.1f} ha) as the lease of {mine['mine_name']}.")


if __name__ == "__main__":
    main()
