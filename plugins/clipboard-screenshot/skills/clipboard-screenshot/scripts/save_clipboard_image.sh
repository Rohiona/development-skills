#!/bin/bash
# Save clipboard image (PNG) to a temporary file and return the path.
# Exit code 0 + prints path on success; exit code 1 on failure.

OUTFILE="/tmp/clipboard_screenshot.png"

osascript -e '
try
    set theImage to the clipboard as «class PNGf»
    set theFile to open for access POSIX file "'"$OUTFILE"'" with write permission
    write theImage to theFile
    close access theFile
    return "ok"
on error errMsg
    return "error: " & errMsg
end try
' 2>/dev/null | {
    read result
    if [[ "$result" == "ok" ]]; then
        echo "$OUTFILE"
        exit 0
    else
        echo "$result" >&2
        exit 1
    fi
}
