.PHONY: install dev build typecheck format db-push db-studio

install:
	bun install

dev:
	bun run dev

build:
	bun run build

typecheck:
	bunx tsc --noEmit

format:
	./node_modules/.bin/prettier --write src/

db-push:
	bunx prisma db push

db-studio:
	bunx prisma studio
