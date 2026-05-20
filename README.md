# httpYac Action

Run `httpyac` test journeys in GitHub Actions and generate:

- raw JSON exchange files
- `metadata.json`
- a Markdown summary for GitHub Actions or local review

## Inputs

| Name | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `scenarios-path` | Yes | - | Directory containing journey folders |
| `output-dir` | No | `./httpyac-results` | Directory for generated reports |
| `env` | Yes | See `action.yml` | Multi-line `KEY=VALUE` variables passed to `httpyac` via `--var` |

Each journey folder is expected to contain a `journey.yaml`.

## Example

```yaml
- name: Run httpYac tests
  uses: ./httpyac-action
  with:
    scenarios-path: ./scenarios
    output-dir: ./httpyac-results
    env: |
      BASE_URL=http://127.0.0.1:4010/api
      LOGIN_USER_ID=00000000-0000-0000-0000-000000000001
```

## Output

The action:

1. finds `journey.yaml` files under `scenarios-path`
2. runs each configured case with `httpyac`
3. writes per-case JSON output into `output-dir`
4. writes `metadata.json`
5. writes a Markdown summary to `GITHUB_STEP_SUMMARY` when available, otherwise `output-dir/summary.md`

## Notes

- Failed requests may include request and response details in the generated summary.
- `env` lines that are empty, commented, or missing `=` are ignored.
- The bundled action runtime uses Node.js 20.
