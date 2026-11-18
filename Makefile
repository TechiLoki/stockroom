.PHONY: up down test smoke logs
up:
	docker compose up --build -d
down:
	docker compose down
test:
	docker compose build api
smoke:
	docker compose exec -T api node scripts/smoke.mjs
logs:
	docker compose logs -f --tail=100 api worker
