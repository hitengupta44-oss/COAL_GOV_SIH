---
title: Coal Mining Governance Backend
emoji: ⛏️
colorFrom: gray
colorTo: blue
sdk: gradio
sdk_version: 4.44.0
app_file: app.py
pinned: false
---

# Coal Mining Smart Governance Platform — Backend API

This Space is the backend for the Coal Mining Smart Governance Platform.
The Gradio tabs are a manual testing console; the frontend (deployed on
Vercel) calls the same functions over Gradio's built-in REST route at
`/api/<function_name>`.

## Endpoints

| Function | Who can call it |
|---|---|
| `get_dashboard_summary` | any logged-in user |
| `get_high_risk_mines` | any logged-in user |
| `get_compliance_status` | own mine; corporate/regulator/admin see all |
| `update_compliance_status` | mine_official (own mine), corporate_admin, admin |
| `log_field_inspection` | inspector, mine_official, contractor_manager, admin |
| `chat_with_data_assistant` | any logged-in user (rate limited) |
| `list_pending_signups` | admin only |
| `approve_user_role` | admin only |

Every endpoint requires a Supabase Auth access token as its first
argument. The backend verifies the token against the same Supabase
project and looks up the caller's role in `user_profiles`.

## Required secrets

Set these under Settings → Repository secrets:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` — privileged queries; bypasses RLS
- `SUPABASE_ANON_KEY` — used only to verify caller tokens
- `GROQ_API_KEY` — powers the chat assistant

`GROQ_MODEL` is optional and defaults to `llama-3.3-70b-versatile`.

## Hardware

Runs on ZeroGPU. The app never uses a GPU — `app.py` defines a no-op
`@spaces.GPU` function purely to satisfy the ZeroGPU startup check, so it
consumes none of the daily quota. The `spaces` package in
`requirements.txt` is required for this.