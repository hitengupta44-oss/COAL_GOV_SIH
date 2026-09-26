title: Coal Governance Platform Backend
emoji: ⛏️
colorFrom: yellow
colorTo: red
sdk: gradio
sdk_version: 4.44.0
app_file: app.py
pinned: false
Coal Mining Governance Platform — Backend
Deploy: push this folder's contents to a new Hugging Face Space (SDK: Gradio). Add these as Repository secrets under Space Settings:

SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
GROQ_API_KEY
GROQ_MODEL (optional — defaults to llama-3.3-70b-versatile, swap in your fine-tuned model slug once ready)
ADMIN_SECRET_KEY — shared secret gating list_pending_signups/approve_user_role (the admin approval flow). Pick any long random string; the frontend's NEXT_PUBLIC_ADMIN_API_KEY must match it exactly.
SUPABASE_ANON_KEY — used to verify caller access tokens. Supabase Dashboard → Settings → API → anon public key. Kept separate from the service-role key so token verification always runs with the least-privileged key.
Once live, your Space URL is: https://<your-username>-<space-name>.hf.space

Each function in app.py is auto-exposed as an API endpoint the frontend can call — see frontend/lib/api.js for the calling convention.

If the build fails after editing requirements.txt
The sdk_version: 4.44.0 in this file's YAML header above must always match the gradio==... pin at the top of requirements.txt. HF Spaces installs gradio[oauth]==<sdk_version> itself, on top of whatever's in requirements.txt — if the two don't match, pip fails immediately with "Cannot install gradio==X and gradio==Y because these package versions have conflicting dependencies," before it even gets to real dependency resolution. If you ever bump gradio, change it in both places. See the comments throughout requirements.txt for why several other versions (pydantic, starlette/fastapi, huggingface_hub, realtime/ websockets) are pinned the way they are — each one was a real deploy failure, root-caused and verified before being pinned, not guessed.