#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# issue-worktree.sh — spin up a git worktree for a GitHub issue or a named
# experiment, then drop you into it. Repo-agnostic: derives the worktree name
# from the current repo and auto-detects the package manager (pnpm/bun/yarn/npm).
#
# Source it (so it can `cd` your shell) rather than execute it:
#     alias is='. /path/to/issue-worktree.sh'
#     is 123            # -> worktree + branch for GitHub issue #123
#     is my-experiment  # -> worktree + branch experiment/my-experiment

# Use `return` when sourced (alias `is` sources this) so we don't kill the user's shell
if (return 0 2>/dev/null); then
    BAIL="return"
else
    BAIL="exit"
fi

ARG=$1
if [ -z "$ARG" ]; then
    printf "🧪 Experiment name: "
    read -r ARG
    if [ -z "$ARG" ]; then
        echo "❌ No name provided"
        $BAIL 1
    fi
fi

# Mode detection: numeric = GitHub issue, otherwise = named experiment worktree
if [[ "$ARG" =~ ^[0-9]+$ ]]; then
    MODE="issue"
    ISSUE_NUMBER=$ARG

    echo "📋 Fetching issue #$ISSUE_NUMBER..."

    ISSUE_TITLE=$(gh issue view $ISSUE_NUMBER --json title -q .title)
    ISSUE_BODY=$(gh issue view $ISSUE_NUMBER --json body -q .body)
    ISSUE_COMMENTS=$(gh issue view $ISSUE_NUMBER --json comments -q '.comments[].body' | sed 's/^/> /')

    if [ -z "$ISSUE_TITLE" ]; then
        echo "❌ Failed to fetch issue #$ISSUE_NUMBER"
        $BAIL 1
    fi

    # Convert title to lowercase, replace spaces/special chars with hyphens, limit to 50 chars
    TITLE_SLUG=$(echo "$ISSUE_TITLE" | \
        tr '[:upper:]' '[:lower:]' | \
        sed 's/[^a-z0-9]/-/g' | \
        sed 's/--*/-/g' | \
        sed 's/^-//;s/-$//' | \
        cut -c1-50)
    BRANCH_NAME="gh/${ISSUE_NUMBER}-${TITLE_SLUG}"
else
    MODE="experiment"
    # Sanitize slug: lowercase, hyphens only, max 50 chars
    TITLE_SLUG=$(echo "$ARG" | \
        tr '[:upper:]' '[:lower:]' | \
        sed 's/[^a-z0-9]/-/g' | \
        sed 's/--*/-/g' | \
        sed 's/^-//;s/-$//' | \
        cut -c1-50)
    if [ -z "$TITLE_SLUG" ]; then
        echo "❌ Invalid experiment name"
        $BAIL 1
    fi
    BRANCH_NAME="experiment/${TITLE_SLUG}"
fi
# Derive worktree prefix from the current repo name (works in any repo)
REPO_NAME="$(basename "$(git rev-parse --show-toplevel)")"
WORKTREE_NAME="${REPO_NAME}-${BRANCH_NAME//\//-}"
WORKTREE_DIR="../$WORKTREE_NAME"

if [ "$MODE" = "issue" ]; then
    echo "✅ Found: $ISSUE_TITLE"
fi
echo "🌿 Branch: $BRANCH_NAME"
echo ""

# First, clean up any prunable worktrees
git worktree prune

# Get absolute path for worktree location
PARENT_DIR="$(cd .. && pwd)"
ABSOLUTE_WORKTREE_DIR="$PARENT_DIR/$WORKTREE_NAME"

# Check if worktree already exists
if [ -d "$ABSOLUTE_WORKTREE_DIR" ]; then
    echo "🔄 Worktree directory already exists at $ABSOLUTE_WORKTREE_DIR"

    # Check if it's registered as a worktree
    if ! git worktree list | grep -q "$ABSOLUTE_WORKTREE_DIR"; then
        echo "Directory exists but not registered as worktree, adding it..."
        # Remove the directory and re-add as worktree
        rm -rf "$ABSOLUTE_WORKTREE_DIR"
        if git show-ref --verify --quiet refs/heads/$BRANCH_NAME; then
            git worktree add "$ABSOLUTE_WORKTREE_DIR" "$BRANCH_NAME"
        else
            git worktree add "$ABSOLUTE_WORKTREE_DIR" -b "$BRANCH_NAME"
        fi
    fi
else
    echo "🌳 Creating worktree..."

    # Check if worktree is registered but directory is missing
    if git worktree list | grep -q "$ABSOLUTE_WORKTREE_DIR"; then
        echo "Removing stale worktree registration..."
        git worktree remove "$ABSOLUTE_WORKTREE_DIR" --force 2>/dev/null || true
    fi

    # Check if branch already exists (local or remote)
    if git show-ref --verify --quiet refs/heads/$BRANCH_NAME; then
        echo "Using existing local branch $BRANCH_NAME..."
        git worktree add "$ABSOLUTE_WORKTREE_DIR" "$BRANCH_NAME"
    elif git ls-remote --heads origin $BRANCH_NAME | grep -q .; then
        echo "Using remote branch origin/$BRANCH_NAME..."
        git worktree add "$ABSOLUTE_WORKTREE_DIR" "origin/$BRANCH_NAME" -b "$BRANCH_NAME"
    else
        echo "Creating new branch $BRANCH_NAME..."
        git worktree add "$ABSOLUTE_WORKTREE_DIR" -b "$BRANCH_NAME"
    fi

    # Copy env files
    cp .env* "$ABSOLUTE_WORKTREE_DIR/" 2>/dev/null || true
fi

# Auto-approve direnv and dotenv BEFORE changing directory
if [ -f "$ABSOLUTE_WORKTREE_DIR/.envrc" ]; then
    echo "🔐 Pre-approving direnv..."
    direnv allow "$ABSOLUTE_WORKTREE_DIR"
fi

# Add worktree directory to dotenv allowed list for Oh My Zsh dotenv plugin
if [ -f "$ABSOLUTE_WORKTREE_DIR/.env" ]; then
    echo "🔐 Pre-approving dotenv..."
    DOTENV_ALLOWED_LIST="$HOME/.oh-my-zsh/cache/dotenv-allowed.list"
    # Create the cache directory if it doesn't exist
    mkdir -p "$(dirname "$DOTENV_ALLOWED_LIST")"
    # Add the worktree directory to the allowed list if not already present
    if ! grep -q "^$ABSOLUTE_WORKTREE_DIR$" "$DOTENV_ALLOWED_LIST" 2>/dev/null; then
        echo "$ABSOLUTE_WORKTREE_DIR" >> "$DOTENV_ALLOWED_LIST"
    fi
fi

# Pre-trust the worktree directory for Claude Code
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
if [ -f "$CLAUDE_SETTINGS" ] && command -v jq &> /dev/null; then
    if ! jq -e ".trustedDirectories // [] | index(\"$ABSOLUTE_WORKTREE_DIR\")" "$CLAUDE_SETTINGS" > /dev/null 2>&1; then
        echo "🔐 Pre-trusting worktree for Claude Code..."
        jq ".trustedDirectories = ((.trustedDirectories // []) + [\"$ABSOLUTE_WORKTREE_DIR\"])" "$CLAUDE_SETTINGS" > "$CLAUDE_SETTINGS.tmp" && mv "$CLAUDE_SETTINGS.tmp" "$CLAUDE_SETTINGS"
    fi
fi

# Change to the worktree directory
cd "$ABSOLUTE_WORKTREE_DIR" || $BAIL 1

# Install dependencies if needed, auto-detecting the package manager from the lockfile
if [ -f "package.json" ] && [ ! -d "node_modules" ]; then
    if [ -f "pnpm-lock.yaml" ]; then
        PM="pnpm"
    elif [ -f "bun.lock" ] || [ -f "bun.lockb" ]; then
        PM="bun"
    elif [ -f "yarn.lock" ]; then
        PM="yarn"
    else
        PM="npm"
    fi
    echo "📦 Installing dependencies with $PM..."
    $PM install
    # Generate Prisma client only if this repo uses Prisma
    if [ -f "prisma/schema.prisma" ] || ls prisma/*.prisma >/dev/null 2>&1; then
        echo "🔧 Generating Prisma client..."
        $PM prisma generate
    fi
elif [ -d "node_modules" ]; then
    echo "✅ Dependencies already installed"
fi

echo ""
echo "✨ Worktree ready at $ABSOLUTE_WORKTREE_DIR"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

cd "$ABSOLUTE_WORKTREE_DIR"
printf '\e]7;file://%s%s\a' "$(hostname)" "$ABSOLUTE_WORKTREE_DIR"

if [ "$MODE" = "issue" ]; then
    echo "📋 Issue #$ISSUE_NUMBER is ready in worktree!"
    echo ""
    echo "Worktree location: $ABSOLUTE_WORKTREE_DIR"
    echo ""
    echo "🤖 Starting Claude with issue context..."
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000 claude --dangerously-skip-permissions /issue $ISSUE_NUMBER
else
    echo "🧪 Experiment worktree ready: $BRANCH_NAME"
    echo ""
    echo "Worktree location: $ABSOLUTE_WORKTREE_DIR"
fi

echo ""
echo "💡 To stay in the worktree directory, run:"
echo "   cd $ABSOLUTE_WORKTREE_DIR"