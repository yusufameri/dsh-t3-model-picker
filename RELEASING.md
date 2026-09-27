# Releasing

`dsh plugin --profile web add dsh-t3-model-picker` pulls from the npm registry.
A version reaches it when a version bump merges to `main`, because the
[Release](.github/workflows/release.yml) workflow reads `version` from
`package.json`, publishes it if the registry does not have it, and attaches the
packed tarball to a GitHub Release named `v<version>`.

## One-time setup

1. Create an npm **granular access token** with *Read and write* permission for
   the `dsh-t3-model-picker` package, and add it to this repository as the
   secret `NPM_TOKEN`:

   ```sh
   gh secret set NPM_TOKEN
   ```

   The publish job reads it and no other step needs npm credentials. A classic
   npm token will not do: npm asks for a one-time password on every publish
   made with one, which a CI runner cannot answer.

2. Confirm the secret landed with `gh secret list`.

Without the secret the workflow still runs and still reports, but it publishes
nothing and says so in a warning annotation. Nothing else breaks.

## Cutting a release

1. Bump `version` in `package.json`.
2. Open a PR and merge it.

That is the whole procedure. The workflow publishes with `--provenance`, which
gives the registry a signed link back to this repository and the exact workflow
run, then creates the GitHub Release with a version-free
`dsh-t3-model-picker.tgz` asset.

Merging anything else is harmless: when the registry already has the version in
`package.json` the publish steps are skipped, so a re-run or a follow-up commit
on the same version changes nothing.

To publish a version that is already on `main` without merging anything, run
the workflow by hand from the Actions tab.

## Publishing by hand

Only for recovering from a workflow failure. The same publish from a clean
checkout, with a granular token in `~/.npmrc`:

```sh
npm publish --access public
```

Then attach the tarball under the version-free asset name that the
`releases/latest/download/` path expects:

```sh
npm pack
mv dsh-t3-model-picker-<version>.tgz dsh-t3-model-picker.tgz
gh release create v<version> dsh-t3-model-picker.tgz
```

Keep the asset name version-free. `releases/latest/download/` resolves `latest`
at request time but takes the filename literally, so a versioned asset name
works on the day it is uploaded and 404s after the next release.

## After the first publish

- The `README.md` install section can drop its "once the package is on npm"
  caveat.
- The plugin list picks up the npm mapping from the registry on its own; its
  entry file needs no `npm:` field.
