.PHONY: help build up down logs shell migrate seed test clean

# Default target
help:
	@echo "CodeForge Development Commands"
	@echo ""
	@echo "  make build     - Build all Docker images"
	@echo "  make up        - Start all services"
	@echo "  make down      - Stop all services"
	@echo "  make logs      - View logs"
	@echo "  make shell     - Open shell in backend container"
	@echo "  make migrate   - Run database migrations"
	@echo "  make test      - Run tests"
	@echo "  make clean     - Remove containers and volumes"
	@echo ""
	@echo "  make dev-back  - Run backend in dev mode (local)"
	@echo "  make dev-front - Run frontend in dev mode (local)"

# Docker commands
build:
	docker-compose build
	docker-compose --profile build-only build sandbox

up:
	docker-compose up -d

down:
	docker-compose down

logs:
	docker-compose logs -f

shell:
	docker-compose exec backend bash

# Database
migrate:
	docker-compose exec backend alembic upgrade head

seed:
	docker-compose exec backend python -c "from app.db.database import init_db; import asyncio; asyncio.run(init_db())"

# Testing
test:
	docker-compose exec backend pytest

# Cleanup
clean:
	docker-compose down --rmi local -v

# Local development
dev-back:
	cd backend && uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

dev-front:
	cd frontend && npm run dev

# Database local
db-local:
	docker run -d --name codeforge-db -p 5432:5432 \
		-e POSTGRES_USER=codeforge \
		-e POSTGRES_PASSWORD=codeforge_secret \
		-e POSTGRES_DB=codeforge \
		postgres:15-alpine

# First-time setup
setup: build
	docker-compose up -d db
	sleep 5
	docker-compose up -d backend
	sleep 3
	docker-compose exec backend alembic upgrade head
	docker-compose up -d frontend
	@echo ""
	@echo "CodeForge is running!"
	@echo "  Frontend: http://localhost:3100"
	@echo "  Backend:  http://localhost:8100"
	@echo "  API Docs: http://localhost:8100/docs"
