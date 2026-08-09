.PHONY: build test run lint typecheck docker-build docker-run docker-up clean load-test

build:
	npm run build

test:
	npm test

run:
	npm start

lint:
	npm run lint

typecheck:
	npm run typecheck

docker-build:
	docker build -t ai-crypto-onramp/gateway-api .

docker-run:
	docker run --rm -p 8080:8080 ai-crypto-onramp/gateway-api

docker-up:
	docker compose up --build

load-test:
	npx autocannon -d 10 -c 100 http://localhost:8080/healthz

clean:
	rm -rf dist node_modules coverage