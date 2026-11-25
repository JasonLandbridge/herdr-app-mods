# Herdr OmniRoute Usage

A Herdr desktop footer mod for OmniRoute. See remaining provider quota or reported wallet balances at a glance. Hover for account details or click to pin the scrollable popup.

## Requirements

- Herdr desktop 0.1.18 (Linux is the tested platform).
- An OmniRoute instance with the provider inventory, provider-limits cache, and scoped CLI access token APIs. The API contract was checked against OmniRoute 3.8.54.

## Install

From a checkout of `herdr-app-mods` on Linux, run:

```sh
app_home="${HERDR_APP_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-app}"
mkdir -p "$app_home/mods"
ln -s "$PWD/herdr-omniroute-usage/mods/herdr-omniroute-usage" "$app_home/mods/herdr-omniroute-usage"
herdr-app check "$app_home/mods/herdr-omniroute-usage"
```

Add this block to the status row in your personal Herdr layout, beside `workspace-status`. Clone a shipped layout first if you do not have a personal layout. Keep the existing status and other footer blocks.

```json
{
  "id": "herdr-omniroute-usage",
  "type": "block",
  "size": { "weight": 3.2 },
  "min": 130,
  "content": { "mod": "herdr-omniroute-usage" }
}
```

Open **OmniRoute** in the footer, select the settings cog, and enter your instance URL and a **read-scoped** OmniRoute CLI access token under **Connection**. Select **Test connection** to verify and save. Remote instances require HTTPS; loopback HTTP is supported. Herdr stores the token unencrypted in its local shared settings. Use a dedicated, revocable token and keep that file out of backups or shares that others can read.

To uninstall, remove the block from your layout and remove only the installed mod symlink. Revoke its access token in OmniRoute if you no longer need it. Removing the link does not erase the saved connection settings.

## Reading the display

- **Display** controls footer and popup visibility independently. Account names stay out of the footer.
- **Date & Time** controls countdowns and timestamp formatting. A passed reset is not treated as replenished until OmniRoute reports new values.
- **Refresh** reloads the OmniRoute cache, not the upstream provider. The popup distinguishes missing, stale, and failed readings.
- **Codex** supports 5-hour, weekly, and Mixed summaries. Automatic capacity mappings cover Plus and Pro Lite weekly; plans without a known weight still appear individually in the popup. See [OmniRoute #21218](https://github.com/cheaper-inference/OmniRoute/issues/21218) for the request for per-window capacity metadata.
- Reported wallet amounts are summed by currency; two keys sharing a wallet can count it twice.
- **Allow Codex redemption** is off by default. It requires a write-scoped token and explicit confirmation for each redemption.

## Verify

From the monorepo root:

```sh
bun test herdr-omniroute-usage/mods/herdr-omniroute-usage/test
herdr-app check herdr-omniroute-usage/mods/herdr-omniroute-usage
```

Based on [herdr-usage-limits](https://github.com/nozikov/herdr-usage-limits). See [LICENSE](LICENSE) and [third-party notices](THIRD-PARTY-NOTICES.md).
