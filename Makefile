.PHONY: help run logs stop clean shell build test view

CONTAINER_NAME=pi-agent-session

# Default target
help:
	@echo "Available commands:"
	@echo "  make run     - Reset output/, scaffold project, rebuild image, and attach to the live agent session"
	@echo "  make logs    - Follow logs from an already running container"
	@echo "  make stop    - Stop and remove the running container"
	@echo "  make clean   - Stop container and wipe output/ directory"
	@echo "  make shell   - Open a shell inside the running container"
	@echo "  make build   - Run production build manually inside the container"
	@echo "  make test    - Verify the dev server responds (curl)"
	@echo "  make view    - Open the website in the browser"

# Run: reset output, scaffold Vite project, build image, start attached container
run:
	bun run index.ts

# Watch container logs in real-time (waits for container to start)
logs:
	@echo "Waiting for container '$(CONTAINER_NAME)' to start..."
	@until docker ps -q -f name=$(CONTAINER_NAME) | grep -q .; do sleep 1; done
	@docker logs -f $(CONTAINER_NAME)

# Stop and remove the container
stop:
	@docker stop $(CONTAINER_NAME) 2>/dev/null || true
	@docker rm $(CONTAINER_NAME) 2>/dev/null || true
	@echo "Container stopped and removed"

# Stop container and wipe output/
clean: stop
	@rm -rf output/*
	@echo "Cleaned output/ directory"

# Open a shell inside the running container
shell:
	@docker exec -it $(CONTAINER_NAME) /bin/bash

# Run production build inside the container
build:
	@docker exec $(CONTAINER_NAME) sh -c "cd $$WORKSPACE_DIR && bun run build"

# Verify the dev server is responding
test:
	@curl -s http://localhost:5173 | head -20

# Open the website in the browser
view:
	@echo "Opening http://localhost:5173"
	@xdg-open http://localhost:5173 2>/dev/null || open http://localhost:5173 2>/dev/null || echo "Open manually: http://localhost:5173"
