.PHONY: help run logs stop clean shell build test

# Default target
help:
	@echo "Available commands:"
	@echo "  make run     - Run the AI agent to create/modify website"
	@echo "  make logs    - Watch agent progress in real-time"
	@echo "  make stop    - Stop the running agent and dev server"
	@echo "  make clean   - Clean output/ directory and reset"
	@echo "  make shell   - Open shell in output/ directory"
	@echo "  make build   - Run production build manually"
	@echo "  make test    - Test if website responds with curl"
	@echo "  make view    - Open website in browser"

# Run the AI agent (clears output/, creates project, starts server, runs agent)
run:
	@export FIREWORKS_API_KEY=$${FIREWORKS_API_KEY} && bun run run.ts

# Run in background and watch logs
run-bg:
	@export FIREWORKS_API_KEY=$${FIREWORKS_API_KEY} && nohup bun run run.ts > agent.log 2>&1 &
	@echo "Agent started in background. Run 'make logs' to watch progress."

# Watch agent logs
logs:
	@tail -f agent.log

# Stop all processes
stop:
	@pkill -f "run.ts" 2>/dev/null || true
	@pkill -f "bun.*dev" 2>/dev/null || true
	@echo "Stopped agent and dev server"

# Clean output directory
clean:
	@rm -rf output/*
	@echo "Cleaned output/ directory"

# Open shell in output directory
shell:
	@cd output && $(SHELL)

# Manual build
build:
	@cd output && bun run build

# Test website
test:
	@curl -s http://localhost:5173 | head -20

# Open website in browser
view:
	@echo "Opening http://localhost:5173"
	@xdg-open http://localhost:5173 2>/dev/null || open http://localhost:5173 2>/dev/null || echo "Open manually: http://localhost:5173"
