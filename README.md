# httpYac Action

Run `httpyac` test journeys in GitHub Actions and generate:

- raw JSON exchange files
- `metadata.json`
- a Markdown summary for GitHub Actions or local review

## Inputs

| Name | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `scenarios-path` | Yes | - | Directory containing `manifest.yaml`, `smoke`, and journey folders |
| `output-dir` | No | `./httpyac-results` | Directory for generated reports |
| `changed-files-path` | No | - | Standardized changed-files JSON used for manifest-based selection |
| `labels` | No | - | PR labels as JSON, comma-separated, or newline-separated values |
| `env` | Yes | See `action.yml` | Multi-line `KEY=VALUE` variables passed to `httpyac` via `--var` |

The action recursively finds `journey.yaml` files under `scenarios-path`.
When `changed-files-path` is provided, the action reads `manifest.yaml` from
`scenarios-path` and uses it to select affected tests. Smoke tests are loaded
from `scenarios-path/smoke` when the `smoke` journey is selected.

## Example

```yaml
- name: Run httpYac tests
  uses: ./httpyac-action
  with:
    scenarios-path: ./scenarios
    changed-files-path: ./changed-files.json
    labels: ${{ toJson(github.event.pull_request.labels.*.name) }}
    output-dir: ./httpyac-results
    env: |
      BASE_URL=http://127.0.0.1:4010/api
      LOGIN_USER_ID=00000000-0000-0000-0000-000000000001
```

## Output

The action:

1. recursively finds `journey.yaml` files under `scenarios-path`
2. selects tests from `manifest.yaml` when `changed-files-path` is provided
3. runs each selected case with `httpyac`
4. writes `selection.json`
5. writes per-case JSON output into `output-dir`
6. writes `metadata.json`
7. writes a Markdown summary to `GITHUB_STEP_SUMMARY` when available, otherwise `output-dir/summary.md`

## Notes

- Failed requests may include request and response details in the generated summary.
- Without `changed-files-path`, all discovered user journeys are run.
- With `changed-files-path`, `scenarios-path/manifest.yaml` must exist.
- `env` lines that are empty, commented, or missing `=` are ignored.
- The bundled action runtime uses Node.js 20.
