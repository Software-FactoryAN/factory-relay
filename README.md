# factory-relay

Shared Mac desktop QA in Factory's embedded browser, with named checks and recordings.
One selected display captures all visible apps, menus, sheets, Dock and menu bar.
Generic mouse move, left/right click, double-click, drag and scroll use the same
approved Factory Relay host. Restricted window mode and the RelayMac count API
remain available. All selected-display content is private local evidence; review
it before sharing.
**iOS input and keyboard/type input are not supported by this slice.**

For agent guidance, see [AGENTS.md](AGENTS.md). Pull requests into `main` follow
the [GitHub merge queue instructions](docs/merge-queue.md).

## Requirements

### Local computer

- Node.js **22+**, npm, Git, and Python **3.9+** (for tests).
- Factory app with its embedded browser, authenticated Droid CLI, and `agent-browser`
  executable. Open this repository as a Factory project.
- Local `ffmpeg` and `ffprobe` on `PATH`, with H.264 encoder `libx264`,
  `drawtext` and `subtitles` filters, and a usable font.
- Project skills **`factory-relay-setup`** and **`factory-relay`**, plus Factory's
  built-in **`agent-browser`** skill. These are automatically discovered in the
  project session. No additional skill or plugin installation is needed.

### Remote Mac

- **Apple Silicon (arm64), macOS 14+**, with a logged-in, unlocked desktop and
  `/usr/bin/python3` **3.9+**.
- Full Xcode, with first-launch setup and license acceptance completed. Select it
  in **Xcode → Settings → Locations → Command Line Tools**.
- Install **iOS Simulator runtimes for the iOS versions you want to test** in
  **Xcode → Settings → Components**. RelayMac itself needs no booted iOS simulator.
- Enable **macOS System Settings → General → Sharing → Remote Management**.
- Separately, sign into Factory with the **same account** as the local computer
  and enable **App Settings → Droid Computers → Remote Control**, or run
  `droid daemon --remote-control`. Use that Mac's registered computer name below.

macOS Remote Management and Factory Remote Control are separate requirements.
Commands use Factory's transport; setup does not change macOS permissions or
network settings for you. **No Node, npm, or second repository clone is needed
on the Mac.** Create its workspace there before continuing:

```sh
mkdir -p "$HOME/Projects/factory-relay"
```

## Setup

To have Droid guide setup, paste this into a local Factory session:

```text
Set up https://github.com/Software-FactoryAN/factory-relay using its README and
factory-relay-setup skill. Reuse an existing checkout or clone a new one.
Confirm my registered Mac and workspace, check prerequisites, and preserve
existing configuration and approved hosts. Ask before system changes or license
acceptance. Guide me through the Mac approvals, then open the embedded QA pane.
Use factory-relay to record one RelayMac check and give me its recording.
```

Or run locally, replacing `YOUR_REGISTERED_MAC` and the Mac username `you`:

```sh
git clone https://github.com/Software-FactoryAN/factory-relay.git
cd factory-relay
npm ci
npm run setup -- --computer YOUR_REGISTERED_MAC --workspace /Users/you/Projects/factory-relay
npm run setup:mac
```

`setup` creates private `config.local.json` and project `.factory/mcp.json`,
preserving unrelated MCP servers and refusing conflicting configuration.
`setup:mac` installs a missing host, builds RelayMac, and opens both apps.
It reuses an intact, matching host and refuses to automatically overwrite or
rebuild an existing approved host.

### Approve Factory Relay on the Mac

In **Factory Relay**, click **Enable screen recording** and **Enable control**,
then approve the macOS prompts for this exact app:

```text
<remote workspace>/.applets-host/Factory Relay.app
```

In **System Settings → Privacy & Security**, grant **Screen Recording** (or
**Screen & System Audio Recording**) and **Device Control and Data Access**
on macOS 27+, or **Accessibility** on earlier versions. Use **Command-Shift-G**
in the file picker to reach the hidden `.applets-host` folder.
If screen status stays stale after approval, click **Check again**, then **Done**.
The app may briefly reopen to refresh macOS permission status.

Approval needs a person at the Mac. Do not grant Terminal or other helpers these
permissions, grant Full Disk Access, reset TCC, or bypass consent.

For an intentional host upgrade only: stop QA, quit Factory Relay, review the
changes, then run `node scripts/build-host.js config.local.json` locally.
This guarded upgrade is separate from setup. Ad-hoc signing means a rebuild
may require permission approval again. Do not rebuild to troubleshoot permissions.
If approvals still refer to an older build, remove only Factory Relay from the
two privacy lists, then add and approve the current app again.

## Daily launch

In the local Factory project, start the broker and keep it running:

```sh
npm run qa -- config.local.json
```

From another terminal or agent command **inside the same Factory project session**:

```sh
npm run qa:open
```

This pairs Factory's existing embedded browser pane, not an external browser.
Optionally run `droid mcp list` to check `factory-relay` and its ten QA tools.
If missing, reload project MCP servers or reopen the project after setup.

Keep RelayMac visible on the unlocked Mac. Ask Droid:
“Use factory-relay with `qa_start({applicationId:"relaymac"})` to check that Increment adds one to the current count,
finish the run, and give me the recording.” Do not assume the count starts at zero.

Configuration, credentials, recordings (`.qa-workspace/`), and artifacts are
private and Git-ignored. Review recordings before sharing. Keep the broker local;
do not expose it through a tunnel or public listener.

## Optional application profiles

Keep `config.local.json` private. Add an optional `applications` array to register
up to 32 apps, then restart the local broker when no run is active. For example:

```json
{
  "applications": [
    {"id":"relaymac","name":"RelayMac","platform":"macos","bundleId":"com.factory.applets.RelayMac"},
    {"id":"editor","name":"My Editor","platform":"macos","bundleId":"com.example.Editor"},
    {"id":"demo-ios","name":"Demo iOS","platform":"ios-simulator","bundleId":"com.example.Demo","simulatorUdid":"abcdef12-1234-4234-8234-123456789012"}
  ]
}
```

Merge this field into your existing config, preserving its transport settings.
Profiles identify an app/device; they contain no app-specific automation.
Omitting it allows desktop-wide control on one selected display. `qa_start({})`
selects the actual main display, never the first discovered entry. Other displays
and restricted windows can be selected explicitly. No per-app profile is needed for generic QA, including
bare executables whose bundle ID is empty. An explicit array is an allowlist;
`[]` authorizes no targets. Any explicit array disables desktop authority. IDs must be unique safe identifiers; profile bundle IDs
cannot contain wildcards. iOS profiles require an exact simulator UUID.

Read `qa_status.applications` for profile shortcuts, or call `qa_targets` for
displays (including `main`, point bounds and stable UUID) and visible authorized
Mac windows. Pass an exact `target` to `qa_start` within 30 seconds of discovery.
Capabilities describe implemented support, not permissions, running apps or device
discovery. Mac profiles use the same generic window driver. RelayMac additionally
supports count observation, increment and integer checks. iOS profiles remain
unsupported and cannot authorize Mac input through a matching bundle identity.

## Generic mouse QA

Use only the existing broker and approved Factory Relay host. The default desktop
target is `{kind:"desktop",displayId,displayUUID}` with a canonical lowercase UUID.
A desktop run permits ordinary cross-app interaction on that display only.
Display disconnect, identity, origin, resolution, scale or rotation changes fail
closed. No keyboard, permission bypass or protected-surface control is provided.

Optional restricted targets remain `{windowId,pid,bundleId}`. Their exact window
must be foreground and unobscured at every input point, including public AX hit
testing. Process identity uses kernel start time, including for bare binaries with
empty bundle IDs. Window mode intentionally rejects other windows and popovers.

Calls below use IDs returned by preceding calls, not guessed IDs:

```text
qa_targets({})
qa_start({title: "Main desktop interaction checks"})
// Or choose a discovered display: target: {kind:"desktop",displayId:DISPLAY_ID,displayUUID:DISPLAY_UUID}
qa_observe({runId: RUN_ID, mode: "pixels", includeImage: true})
qa_act({runId: RUN_ID, action: "mouse", observationId: OBSERVATION_ID,
  mouse: {kind: "click", x: 0.25, y: 0.5, button: "left", count: 1}})
qa_check({runId: RUN_ID, kind: "visual", observationId: RETURNED_OBSERVATION_ID,
  title: "Expected view is visible", expected: "Describe the intended view",
  actual: "Describe the screenshot you inspected", outcome: "pass"})
qa_observe({runId: RUN_ID, mode: "pixels", includeImage: true})
qa_act({runId: RUN_ID, action: "mouse", observationId: OBSERVATION_ID,
  mouse: {kind: "drag", x: 0.2, y: 0.6, toX: 0.7, toY: 0.6, durationMs: 500}})
qa_check({runId: RUN_ID, kind: "visual", observationId: RETURNED_OBSERVATION_ID,
  title: "Drag result", expected: "Describe the intended final position",
  actual: "Describe the post-drag screenshot", outcome: "pass"})
qa_finish({runId: RUN_ID})
qa_report({runId: RUN_ID, waitMs: 30000})
```

Use `button:"right"` for a right click and `count:2` for a double click.
Other mouse commands are `{kind:"move",x,y}` and
`{kind:"scroll",x,y,deltaX,deltaY}`. Scroll deltas are signed integer pixels,
bounded to ±600 on each axis. Drag duration is 100–1000 ms with bounded steps.
Always inspect the returned post-action image and record a check after input.
Choose the outcome from the inspected screenshot. The example text and coordinates
are illustrative, not app-specific assertions or control locations.

Coordinates are normalized **[0,1)**, with the selected target's top-left at
`(0,0)`. Desktop `displayConfiguration.boundsPoints` includes negative origins,
with exact pixel dimensions, scale and rotation. Restricted windows retain
`windowRectPoints` and `processStartedAt`. For a raw JPEG
pixel `(px,py)`, use
`x=(px-contentRectPixels[0])/contentRectPixels[2]` and
`y=(py-contentRectPixels[1])/contentRectPixels[3]`.
Use `imageGeometry` from the same observation. Do not divide by a browser's
letterboxed rectangle or the exported 1280×720 video dimensions.

`qa_observe` binds fresh pixels to display identity/configuration or window geometry
and process start. Slow native observation and idle capture trigger a fresh capture
within the bounded startup budget, without relaxing the two-second frame-age limit.
Generic `actual` is null. Observations expire within 30 seconds and are consumed
before input. Acknowledgement is separate from an assertion. Never automatically
retry uncertain mouse input. Native drag cleanup releases a held button on
validation failure or IPC interruption; uncertain replies retain recovery fencing.

Visual checks require a fresh, unconsumed observation and bounded expected/actual
text. The recorded outcome is the caller's screenshot assessment, explicitly
`serverVerified:false`, not a server-computed fact. Checks retain frame links and
recorded footage in the default QA MP4, with conservative preceding-input context
and marked gaps. Existing journals and ready exports are not rewritten.

Live keeps the same shared image and ownership controls. Count controls are
disabled for desktop and generic windows. Human pointer interaction in the Live image is not
implemented; generic input uses `qa_act`, not a second native bridge.

### Recording storage and deletion

Recording deletion currently requires the local broker to run on Linux.

Recordings shows file-content sizes for source JPEGs/journals and all generated
exports, plus separate source (2 GiB) and export (512 MiB) limits and the 64-run
limit. Binary units exclude filesystem metadata/allocation overhead. Completed
export sizes are cached; Refresh updates the library and in-progress sizes.

Use a row's **Delete** action or **Delete recording…** in replay details. The
paired browser requires a named, permanent-deletion confirmation; Cancel removes
nothing. Active recordings and queued/encoding exports cannot be deleted. Wait
for completion, then refresh. No destructive MCP tool or automatic retention
purge is provided. Deletion releases the run slot and its source/export capacity.

The Linux broker records a durable, exact-file deletion intent before cleanup.
Failed deletion stays pending and cannot replay or regenerate exports. Retry
resumes only that confirmed recording; restart also resumes confirmed cleanup.
Unknown files, links or changed file identities stop cleanup rather than deleting
unrecognized data. Source and export directories are checked independently.

## License

[MIT](LICENSE). Copyright (c) 2026 Cynthia Toporowski.
