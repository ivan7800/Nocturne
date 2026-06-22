# SaaS roadmap

This repository is the static GitHub-ready edition. A commercial SaaS edition would be a separate product, because GitHub Pages cannot provide secure accounts, billing, private cloud storage or server-side processing by itself.

## Phase 1 — Account layer

- Authentication with email/social login.
- User profile.
- Private cloud library.
- Terms, privacy policy and account deletion flow.

Recommended stack:

- Supabase or Firebase for auth and database.
- Postgres schema for scenes, libraries and user settings.
- Row-level security for private user data.

## Phase 2 — Sync and collaboration

- Cloud sync across devices.
- Scene version history.
- Shared read-only scene links.
- Optional collaborative libraries.

## Phase 3 — Monetization

- Free local tier.
- Paid cloud tier.
- Stripe subscriptions.
- Usage limits for private libraries and collaboration.

## Phase 4 — Professional edition

- Team workspaces.
- Project folders.
- Audio export/render pipeline.
- Creator marketplace for presets.
- Optional AI scene assistant using user-provided API keys or a paid backend.

## Security requirements before SaaS

- Server-side auth checks.
- Rate limiting.
- Input validation on every API endpoint.
- Billing webhook verification.
- Data export/deletion.
- Privacy and GDPR compliance.
