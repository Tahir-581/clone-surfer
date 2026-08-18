FROM node:20-bookworm-slim AS frontend-builder

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend ./
RUN npm run build


FROM mcr.microsoft.com/playwright/python:v1.40.0-jammy

WORKDIR /app/backend

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV BACKEND_PORT=8010
ENV PORT=8010
ENV FRONTEND_DIR=/app/frontend/build

COPY backend/requirements.txt /tmp/backend-requirements.txt
RUN pip install --no-cache-dir -r /tmp/backend-requirements.txt
RUN python -m playwright install chromium

COPY backend /app/backend
COPY --from=frontend-builder /app/frontend/build /app/frontend/build

RUN mkdir -p /app/backend/results /app/backend/uploads "/app/backend/json outputs"

EXPOSE 8010

CMD ["python", "main.py"]
