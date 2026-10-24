# The news desk: `just backend` plus the news pack (one document, the `news` tool, the digest run).
# `just backend dev` runs the bare device; this one runs the news desk.

set shell := ["bash", "-uc"]
set positional-arguments
set working-directory := "../../apps/dpi-news-backend"

free-port := source_directory() / ".." / "free-port.sh"
# The port the news desk binds: $DPI_PORT, else DPI_PORT in ~/.dpi/backend.env, else 4782 (the demo keeps 4780).
port := 'p=${DPI_PORT:-$(sed -n "s/^DPI_PORT=//p" "${DPI_HOME:-$HOME/.dpi}/backend.env" 2>/dev/null | head -1)}; echo ${p:-4782}'

# List news desk commands
[default]
default:
    @just --list news

# Run the news desk device (frees the port first)
run *ARGS:
    @{{ free-port }} "$({{ port }})"
    npm start -- "$@"

# Run with restart on file changes (frees the port)
dev *ARGS:
    @{{ free-port }} "$({{ port }})"
    npm run dev -- "$@"

# Type check and run the news desk tests
check:
    npm run check
    npm test
