# Setoku release notes

The deploy notice (lib/notify.ts) posts the notes for every version newer than
the one a box was running, so keep each entry short and written for the team
that uses the box, not for contributors: what they can do now, in a few bullets.
Add an entry when you bump plugin/.claude-plugin/plugin.json. A version with no
entry just announces the version number.

## v0.24.0
- Agents can now see what they built: `preview_app` screenshots an app the way a viewer sees it and reports what broke (JS errors, fonts or images that didn't load, blocked external links, empty panels), so fixes happen before you open the link.
- Deploy notices in Slack now include these release notes.

## v0.23.0
- Apps can use your own files: attach a font, logo, image, audio or video clip, stylesheet, script, or markdown doc to an app and reference it in the template as `setoku-file:<name>`.
- A design team's stylesheet works as-is: its relative font/image paths resolve to attached files.
- Shared audio and video files play right in the file viewer.
