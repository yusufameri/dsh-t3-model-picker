# Releasing

`dsh plugin --profile web add dsh-t3-model-picker` only works for other people
once the package is on the npm registry. Until then they install from this
repository or from the release tarball; both work today and are documented in
the [README](README.md#install).

## One-time setup

1. Sign in to npm: `npm login` (or drop a token in `~/.npmrc`).
2. Create an npm **granular access token** with *Read and write* permission for
   the `dsh-t3-model-picker` package, and add it to this repository as the
   secret `NPM_TOKEN` (`gh secret set NPM_TOKEN`). The publish job reads it;
   no other step needs npm credentials.

## Cutting a release

1. Bump `version` in `package.json` and commit it.
2. Tag and push:

   ```sh
   git tag v1.2.3
   git push origin main --tags
   ```

3. The [`Release`](.github/workflows/release.yml) workflow checks that the tag
   matches `package.json`, publishes with `--provenance`, and attaches the
   packed tarball to a GitHub Release named after the tag. Provenance gives the
   registry a signed link back to this repository and the exact workflow run.

## Publishing by hand

If the workflow is unavailable, the same publish from a clean checkout:

```sh
npm publish --access public
```

Then attach the tarball under the version-free asset name the `tarball:` field
in the plugin list expects:

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
