# Surfox (clone-surfer)

**SEO keyword research & SERP analysis** tool. FastAPI backend with Playwright automation, React frontend, and PostgreSQL — packaged for Docker.

## Features

- Batch keyword / SERP processing
- Playwright-based browser automation
- Admin user bootstrap (`create_admin.py`)
- NLP health checks (`check_nlp_health.py`)
- Results and uploads persisted under `backend/results`, `backend/uploads`

## Stack

- **Backend:** Python, FastAPI, Playwright (`backend/`)
- **Frontend:** React (`frontend/`)
- **Database:** PostgreSQL 16

## Quick start (Docker)

```bash
cp .env.example .env   # configure secrets
docker compose up --build
```

App listens on **http://localhost:8010** (maps container port 8010).

### Database

Default `docker-compose.yml` runs Postgres in-container (`serfox_db`). To use an external Postgres host, set `POSTGRES_HOST` in `.env` / compose environment.

## Local development

```bash
# Backend
cd backend
pip install -r requirements.txt
python -m playwright install chromium
python main.py

# Frontend
cd frontend
npm ci && npm run build
```

## Project structure

```
backend/     # API, scrapers, NLP
frontend/    # React UI (built into Docker image)
surfer-models/
google_serp_session/
```

## Scripts

| Script | Purpose |
|--------|---------|
| `run_services.py` | Start combined services |
| `generate_descriptions.py` | Bulk description generation |
| `test.batch_search.py` | Batch search tests |

## License

Private — internal use.
