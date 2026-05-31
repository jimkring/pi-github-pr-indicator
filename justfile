set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

_default:
	just --list

fmt:
	npm run fmt

lint:
	npm run lint

test:
	npm test

check:
	npm run check

pack:
	npm run pack:dry-run

verify:
	npm run verify
