#!/bin/bash
# Fleet Commander: JSON escaping tests for send_event.sh
# Validates that json_encode_string produces valid JSON for payloads
# containing newlines, tabs, quotes, backslashes, and embedded JSON.
#
# Usage: bash tests/e2e/test-json-escape.sh
#
# Tests both the default path and the awk fallback path by spawning
# child bash processes that source the functions from send_event.sh.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOOKS_DIR="$REPO_ROOT/hooks"
SEND_EVENT="$HOOKS_DIR/send_event.sh"

PASSED=0
FAILED=0

assert_eq() {
    if [ "$1" = "$2" ]; then
        PASSED=$((PASSED + 1))
        echo "  PASS: $3"
    else
        FAILED=$((FAILED + 1))
        echo "  FAIL: $3"
        echo "    expected: $2"
        echo "    got:      $1"
    fi
}

# Validate JSON using node (always available in this project)
assert_valid_json() {
    local json="$1"
    local desc="$2"
    if printf '%s' "$json" | node -e "
        const d = require('fs').readFileSync(0, 'utf8');
        try { JSON.parse(d); process.exit(0); }
        catch(e) { console.error(e.message); process.exit(1); }
    " 2>/dev/null; then
        PASSED=$((PASSED + 1))
        echo "  PASS: $desc"
    else
        FAILED=$((FAILED + 1))
        echo "  FAIL: $desc (invalid JSON)"
        echo "    payload: $json"
    fi
}

# Source functions using process substitution to avoid eval backslash issues
source <(sed -n '/^json_encode_string()/,/^}/p' "$SEND_EVENT")
source <(sed -n '/^json_field()/,/^}/p' "$SEND_EVENT")

# Create a helper script for testing the awk fallback path.
# This script redefines json_encode_string to skip the jq branch.
AWK_HELPER=$(mktemp)
{
    # Extract the awk-only fallback from the else branch
    echo 'json_encode_string() {'
    sed -n '/^json_encode_string()/,/^}/p' "$SEND_EVENT" | \
        sed -n '/^    else$/,/^    fi$/p' | \
        sed '1d;$d'
    echo '}'
    # Also include json_field
    sed -n '/^json_field()/,/^}/p' "$SEND_EVENT"
    # Read mode from first arg, input from stdin
    echo 'if [ "$1" = "field" ]; then'
    echo '    shift'
    echo '    json_field "$@"'
    echo 'else'
    echo '    json_encode_string'
    echo 'fi'
} > "$AWK_HELPER"

# run_encode: encodes stdin input, using the specified mode
run_encode() {
    local input="$1"
    local mode="$2"
    if [ "$mode" = "awk-fallback" ]; then
        printf '%s' "$input" | bash "$AWK_HELPER"
    else
        printf '%s' "$input" | json_encode_string
    fi
}

run_field() {
    local mode="$1"
    local key="$2"
    local val="$3"
    if [ "$mode" = "awk-fallback" ]; then
        bash "$AWK_HELPER" field "$key" "$val"
    else
        json_field "$key" "$val"
    fi
}

run_tests_for_mode() {
    local mode="$1"

    echo ""
    echo "=== Testing mode: $mode ==="

    # Test 1: Simple string
    echo "1. Simple string"
    result=$(run_encode "hello world" "$mode")
    assert_eq "$result" '"hello world"' "simple string encodes correctly ($mode)"

    # Test 2: String with double quotes
    echo "2. Double quotes"
    result=$(run_encode 'say "hello"' "$mode")
    assert_eq "$result" '"say \"hello\""' "double quotes escaped ($mode)"

    # Test 3: String with backslashes
    echo "3. Backslashes"
    result=$(run_encode 'path\to\file' "$mode")
    assert_eq "$result" '"path\\to\\file"' "backslashes escaped ($mode)"

    # Test 4: String with newlines
    echo "4. Newlines"
    input="$(printf 'line1\nline2\nline3')"
    result=$(run_encode "$input" "$mode")
    assert_eq "$result" '"line1\nline2\nline3"' "newlines escaped ($mode)"

    # Test 5: String with tabs
    echo "5. Tabs"
    input="$(printf 'col1\tcol2\tcol3')"
    result=$(run_encode "$input" "$mode")
    assert_eq "$result" '"col1\tcol2\tcol3"' "tabs escaped ($mode)"

    # Test 6: String with carriage returns
    echo "6. Carriage returns"
    input="$(printf 'line1\r\nline2')"
    result=$(run_encode "$input" "$mode")
    assert_eq "$result" '"line1\r\nline2"' "carriage returns escaped ($mode)"

    # Test 7: Embedded JSON (the real-world case from the bug)
    echo "7. Embedded JSON"
    input='{"session_id":"sess_abc","tool_name":"Bash","output":"hello\nworld"}'
    result=$(run_encode "$input" "$mode")
    assert_valid_json "{\"test\":$result}" "embedded JSON produces valid outer JSON ($mode)"

    # Test 8: Mixed control characters
    echo "8. Mixed special characters"
    input="$(printf 'quote: \" backslash: \\ newline:\ntab:\there')"
    result=$(run_encode "$input" "$mode")
    assert_valid_json "{\"test\":$result}" "mixed special chars produce valid JSON ($mode)"

    # Test 9: Empty string
    echo "9. Empty string"
    result=$(run_encode "" "$mode")
    assert_eq "$result" '""' "empty string encodes to empty JSON string ($mode)"

    # Test 10: json_field integration
    echo "10. json_field with special characters"
    field_result=$(run_field "$mode" "key" 'value with "quotes"')
    assert_valid_json "{${field_result%,}}" "json_field output is valid JSON ($mode)"

    # Test 11: Multi-line tool output (realistic CC hook payload)
    echo "11. Realistic multi-line tool output"
    input="$(printf '{\n  "tool_name": "Bash",\n  "output": "Running tests...\\nAll 42 tests passed\\n",\n  "exit_code": 0\n}')"
    result=$(run_encode "$input" "$mode")
    assert_valid_json "{\"cc_stdin\":$result}" "realistic multi-line payload produces valid JSON ($mode)"

    # Test 12: String with only special characters
    echo "12. Only special characters"
    input="$(printf '"\\\n\t')"
    result=$(run_encode "$input" "$mode")
    assert_valid_json "{\"test\":$result}" "only-special-chars string produces valid JSON ($mode)"
}

echo "=== Fleet Commander: JSON Escape Tests ==="

# Run tests with the default path (jq if available, awk fallback otherwise)
if command -v jq >/dev/null 2>&1; then
    run_tests_for_mode "jq"
else
    echo ""
    echo "=== NOTE: jq not installed, default path uses awk fallback ==="
fi

# Run tests with awk fallback (always tests the awk path)
run_tests_for_mode "awk-fallback"

# ── Full payload integration test ────────────────────────────────
echo ""
echo "=== Full payload integration test ==="

# Simulate what send_event.sh does: build a complete JSON payload
# with cc_stdin containing embedded JSON with newlines
echo "13. Full payload with embedded JSON stdin"
CC_STDIN='{"session_id":"sess_123","tool_name":"Edit","tool_input":{"file":"test.ts","content":"line1\nline2\n\"quoted\""}}'
PAYLOAD="{"
PAYLOAD="${PAYLOAD}$(json_field "event" "tool_use")"
PAYLOAD="${PAYLOAD}$(json_field "team" "kea-777")"
PAYLOAD="${PAYLOAD}$(json_field "timestamp" "2026-03-16T14:30:45Z")"
ENCODED=$(printf '%s' "$CC_STDIN" | json_encode_string)
PAYLOAD="${PAYLOAD}\"cc_stdin\":${ENCODED},"
PAYLOAD=$(printf '%s' "$PAYLOAD" | sed 's/,$//')
PAYLOAD="${PAYLOAD}}"
assert_valid_json "$PAYLOAD" "full payload with embedded JSON is valid"

# Clean up
rm -f "$AWK_HELPER"

echo ""
echo "=== Results: $PASSED passed, $FAILED failed ==="
if [ "$FAILED" -gt 0 ]; then
    exit 1
fi
echo "All tests passed!"
