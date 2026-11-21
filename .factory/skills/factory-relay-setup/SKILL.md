---
name: factory-relay-setup
description: Set up factory-relay on a local Factory workstation and an authorized Mac. Use when the user asks for initial setup or setup troubleshooting, not routine QA.
license: MIT
---

# Set up factory-relay

Read the [Software-FactoryAN/factory-relay README](../../../README.md) and setup
scripts first. Use the provided setup commands, not a second installer or native
driver.

1. Inspect existing configuration without printing credentials. Identify the
   authorized Mac from Factory's computer list. Ask which Mac to use if ambiguous.
   Confirm its absolute workspace path; never guess a user's home directory.
2. Check local Node, npm, Droid, agent-browser, ffmpeg and ffprobe prerequisites.
   Check Mac architecture, Python, selected Xcode and logged-in desktop. Follow
   the README for missing prerequisites. Ask before system package installation,
   privilege changes or accepting license agreements.
3. Run `npm ci`, then the README's `npm run setup -- ...` command with the chosen
   computer and workspace. Preserve existing configuration and unrelated MCP
   servers. If setup refuses conflicting files, explain the conflict rather
   than deleting or overwriting them.
4. Use `npm run setup:mac` for guarded host/sample preparation. Do not run this
   during another active QA session. Never rebuild or rename an existing
   permission-approved host merely to diagnose permissions.
5. The setup command opens the host's permission window. Guide the user to click
   its screen recording and control request buttons, then approve macOS prompts.
   Only the host app receives screen recording and device/accessibility control.
   Do not grant these to Terminal, SSH or Python; do not edit TCC or bypass prompts.
6. Start the broker using the environment's background process manager. Record
   the process you own. Use the `agent-browser` skill and `npm run qa:open` inside
   Factory's project session to pair its embedded pane. Preserve assigned CDP
   and browser session values. Never print private pairing codes or tokens.
7. Confirm `droid mcp list` discovers factory-relay and its ten QA tools.
   Call `qa_status`. If the user authorizes a sample smoke test, follow the
   `factory-relay` skill with `qa_start({applicationId:"relaymac"})` to record a
   passing count check and finish it. No-target QA now selects the main desktop
   display when applications configuration is omitted. Explicit application arrays
   remain restricted-window allowlists and never authorize the desktop. Otherwise
   report the connection checks performed and that native input is untested.

Stop for missing permissions, ambiguous targets or another controller's run.
Never take over a human session to finish setup. Report what works, what remains
blocked and the routine startup commands. Leave the broker running only when
needed for the user's requested session.
