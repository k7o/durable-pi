# The demo device: dpi-backend plus the playground pack (App State, todos, durable jobs, the pager).
# `just backend dev` runs the bare device; this one runs the demo.

set shell := ["bash", "-uc"]
set positional-arguments
set working-directory := "../../apps/dpi-demo-backend"

free-port := source_directory() / ".." / "free-port.sh"
# The port the demo binds: $DPI_PORT, else DPI_PORT in ~/.dpi/backend.env, else 4780.
port := 'p=${DPI_PORT:-$(sed -n "s/^DPI_PORT=//p" "${DPI_HOME:-$HOME/.dpi}/backend.env" 2>/dev/null | head -1)}; echo ${p:-4780}'

# List demo commands
[default]
default:
    @just --list demo

# Run the demo device (frees the port first)
run *ARGS:
    @{{ free-port }} "$({{ port }})"
    npm start -- "$@"

# Run with restart on file changes (frees the port)
dev *ARGS:
    @{{ free-port }} "$({{ port }})"
    npm run dev -- "$@"

# Type check and run the demo tests
check:
    npm run check
    npm test
