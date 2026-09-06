# package-stats

Master Package Telemetry & Download Engine for PyPI (`pip`) and NPM (`npx`) packages.

## Features
- Fetches real-time download telemetry across PyPI (`pypistats.org`) and NPM (`api.npmjs.org`).
- Computes metrics: age, downloads per day, downloads per month (30-day), and total lifetime downloads.
- **Built-in DNS Resilience:** Includes automatic fallback to Cloudflare (`1.1.1.1`) and Google (`8.8.8.8`) DNS-over-HTTPS (DoH) if local ISP resolvers return `SERVFAIL` or `Errno 8`.
- **Zero-Day Launch Support:** Handles newly registered packages before registry stats aggregation batches run without breaking cache persistence.
- **Outage Protection:** Caches verified numbers so upstream API rate limits or drops never zero out your metrics.

## CLI Usage
```bash
# Run telemetry report
package-stats

# Run detailed report (includes second table listing what each program does)
package-stats-detailed
# or:
package-stats --detailed

# Add / remove packages from monitoring
package-stats --add-npm <package-name>
package-stats --add-pip <package-name>
package-stats --set-desc <package-name> "<description>"
package-stats --list

# Output raw JSON
package-stats --json
```
