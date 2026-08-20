# Profile recipes

Everything here is `.leveret.yml` configuration — no leveret code involved. The
`custom:` entries rely on the SARIF adapter: any command that prints SARIF 2.1.0 to
stdout plugs in. A tool that only writes SARIF to a file wraps in `sh -c "... && cat"`.

## PHP taint analysis (Psalm)

Free taint-flow tracking (source → sink injection paths) for PHP repos. Psalm needs a
project-level install and `psalm.xml`; then:

```yaml
custom:
  - id: psalm-taint
    command: ["sh", "-c", "vendor/bin/psalm --taint-analysis --report=/dev/stdout --report-show-info=false --output-format=sarif"]
    files: ["**/*.php", "**/*.inc"]
```

Note: Psalm analyses the whole project regardless of the selected files — the `files`
globs only decide *when* it runs. The delta layer still filters its output to
findings introduced by the change.

## Dockerfiles (hadolint)

```yaml
custom:
  - id: hadolint
    command: ["hadolint", "--format", "sarif"]
    files: ["**/Dockerfile*", "**/*.dockerfile"]
```

## IaC misconfiguration (trivy)

```yaml
custom:
  - id: trivy-config
    command: ["trivy", "config", "--format", "sarif", "--quiet", "."]
    files: ["**/*.tf", "**/helm/**", "**/Dockerfile*", "**/docker-compose*.yml"]
```

## Duplication corpus (jscpd, built-in)

```yaml
engines:
  jscpd:
    corpus: ["src/**", "scripts/**"]
    minTokens: 50
```

## Custom repo rules (built-in semgrep / ast-grep engines)

Promote recurring memory verdicts into rules:

```yaml
engines:
  semgrep:
    rules: [".leveret/rules/semgrep.yml"]
  ast-grep:
    rules: [".leveret/sgconfig.yml"]
```

Example — a repo that mandates `uv run` over bare `python`:

```yaml
# .leveret/rules/semgrep.yml
rules:
  - id: repo-bare-python-invocation
    languages: [generic]
    severity: WARNING
    message: this repo invokes Python through `uv run`, never bare `python`
    paths:
      include: ["**/*.md", "**/*.sh", "**/*.yml"]
    pattern: python -m pytest
```

## Not recommended

- **SonarQube**: server-bound scanner, taint analysis paywalled, and its linting
  overlaps the built-in engines. The complexity/duplication signal it sells is the
  `context` tool + jscpd here.
- **trufflehog verified mode**: sends discovered candidate secrets to live services
  for verification — wrong default for a privacy-first tool. gitleaks covers the
  detection side.
- **CodeQL as a default**: license restricts analysis of non-OSS code; where it is
  permitted, it plugs in as a `custom:` SARIF command like everything else.
