# Atlas

Atlas is Rangeway's internal relationship and site-development system. It is intentionally not a generic sales CRM. It tracks the people, locations, diligence, and next steps behind a hospitality-driven EV charging network.

## What Is Included

- Google Workspace sign-in for `rangeway.energy` accounts.
- Development password fallback for local work.
- User profiles, with next steps assignable to Atlas users.
- Stakeholders with Rangeway-specific types: hotel operators, real estate partners, landowners, utilities, energy partners, charging partners, investors, public agencies, vendors, team members, and community contacts.
- Location pursuits with Rangeway network fields: Trailhead, Waystation, Basecamp, Summit, development phase, corridor, road context, land status, utility status, power strategy, hospitality scope, next milestone, and risk level.
- Next steps that can be tied to a stakeholder, location pursuit, or both.
- Diligence document uploads for PDF, DOC, DOCX, XLS, and XLSX with document type and development phase.
- Activity timelines for stakeholders and location pursuits, including notes, calls, meetings, site visits, decisions, risks, and milestones.
- CSV exports for stakeholders, location pursuits, and next steps.
- Auth-protected downloads from local storage.
- SQLite persistence with Docker volumes for `data` and `uploads`.
- VPS deployment using Docker Compose and Caddy HTTPS.

## Rangeway Workflow Model

The app is organized around the work Rangeway actually does:

- **Stakeholders**: relationship intelligence for people and organizations that can unlock a site, fund it, power it, permit it, build it, operate it, or support it.
- **Location Pursuits**: the project tracker for prospective Rangeway sites and corridors.
- **Diligence**: controlled storage for site, land, utility, design, permitting, capital, partner, and operations files.
- **Next Steps**: the practical follow-through layer for introductions, LOIs, utility screens, partner reviews, permitting items, and internal action items.
- **Activity**: the running context log that explains what happened, who logged it, and what decisions or risks changed.

The dashboard focuses on active site pursuits, early-stage development, risk, development phase, format mix, upcoming next steps, and recent diligence.

## Local Development

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:5173`.

Google SSO is optional locally. Default development credentials are:

- Email: `admin@rangeway.energy`
- Password: `rangeway-dev`

Set real credentials in `.env` before production.

## Useful Commands

```bash
npm run typecheck
npm run build
npm start
```

## Environment

Copy `.env.example` to `.env` and update:

```bash
CRM_DOMAIN=atlas.rangeway.app
PUBLIC_URL=https://atlas.rangeway.app
ADMIN_EMAIL=admin@rangeway.energy
ADMIN_PASSWORD=use-a-long-password
SESSION_SECRET=use-a-long-random-secret
GOOGLE_CLIENT_ID=your-google-oauth-client-id
GOOGLE_CLIENT_SECRET=your-google-oauth-client-secret
GOOGLE_ALLOWED_DOMAIN=rangeway.energy
DATABASE_PATH=/app/data/rangeway-crm.sqlite
UPLOAD_DIR=/app/uploads
MAX_UPLOAD_MB=30
```

Generate a session secret with:

```bash
openssl rand -base64 48
```

## VPS Deployment

This app is designed to run on an Ubuntu VPS with Docker.

1. Point DNS for `atlas.rangeway.app` to the VPS public IP.
2. Install Docker and the Compose plugin on the VPS.
3. Create production env values locally.
4. Deploy over SSH.

```bash
cp deploy/env.production.example .env.production
openssl rand -base64 48
# Edit .env.production and paste SESSION_SECRET plus Google OAuth values.

ATLAS_HOST=your-vps-ip ATLAS_USER=root ./deploy/deploy.sh
```

Caddy will request and renew HTTPS certificates automatically once DNS points at the server and ports `80` and `443` are open.

If the VPS does not have Docker yet, copy and run the bootstrap script once:

```bash
scp deploy/bootstrap-ubuntu.sh root@your-vps-ip:/tmp/bootstrap-ubuntu.sh
ssh root@your-vps-ip 'bash /tmp/bootstrap-ubuntu.sh'
```

## Google Workspace SSO

Create an OAuth client in Google Cloud for a web application.

Use these values for production:

- Authorized JavaScript origin: `https://atlas.rangeway.app`
- Authorized redirect URI: `https://atlas.rangeway.app/api/auth/google/callback`

For local testing with Google SSO, add:

- Authorized JavaScript origin: `http://localhost:5173`
- Authorized redirect URI: `http://localhost:5173/api/auth/google/callback`

Then set:

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_ALLOWED_DOMAIN=rangeway.energy
PUBLIC_URL=https://atlas.rangeway.app
```

Atlas sends `hd=rangeway.energy` to Google for Workspace routing and also verifies the signed-in user has a verified `rangeway.energy` email before creating or updating their profile.

## Updating Production

```bash
git pull
docker compose up -d --build
docker compose logs -f crm
```

## Backups

The important production data lives in Docker volumes:

- `rangeway-crm_crm-data`
- `rangeway-crm_crm-uploads`

For a simple server-side backup:

```bash
mkdir -p ~/rangeway-crm-backups
docker run --rm -v rangeway-crm_crm-data:/data -v "$HOME/rangeway-crm-backups:/backup" alpine tar czf /backup/crm-data-$(date +%F).tgz -C /data .
docker run --rm -v rangeway-crm_crm-uploads:/uploads -v "$HOME/rangeway-crm-backups:/backup" alpine tar czf /backup/crm-uploads-$(date +%F).tgz -C /uploads .
```

## Hostinger API Notes

Hostinger has an API for account and VPS operations, including VPS stats and management. Their docs say API tokens are generated in hPanel account settings, and they provide official PHP, Python, and TypeScript SDKs plus a `hapi` CLI.

For Atlas, the simplest first deployment path is still SSH plus Docker Compose. The Hostinger API is useful later for automation such as listing VPS instances, checking metrics, restarting a VPS, or wiring deployment commands into CI.

References:

- [What Is Hostinger API](https://www.hostinger.com/support/10840865-what-is-hostinger-api/)
- [Introduction to Hostinger API SDKs](https://www.hostinger.com/support/11080244-introduction-to-hostinger-api-sdks/)
- [How to Use Hostinger API CLI](https://www.hostinger.com/support/11679133-how-to-use-hostinger-api-cli/)
