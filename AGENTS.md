# UI model names

Never expose raw model IDs in the UI. Always use human-readable model names in visible text, tooltips, and accessibility labels. Use the shared model display helpers in `propr-ui/src/utils/modelDisplay.ts`: prefer the catalog name and humanize unknown or historical IDs rather than falling back to the raw ID. Keep raw IDs only as internal keys, selection values, and API payloads.
