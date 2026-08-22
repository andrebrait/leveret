# Serena upstream language-server acquisition

Status: engineering/licensing research for Leveret. This is not legal advice.
Implementation tracking: [issue #40](https://github.com/leveret-dev/leveret/issues/40).
Terms reviewed: 2026-08-22. Recheck them before each catalog update.

## Decision

Leveret will bundle every artifact that clears the redistribution and practical
gates. For a remaining supported server, the default is disclosure plus an
operator-provided installation: show the exact upstream source, terms, requirements,
and Serena configuration, then detect a canonical executable or toolchain path below
an owner-controlled root. Leveret does not fetch anything merely because Serena
supports it.

Where a component-specific acquisition review permits it, an owner may instead opt
in to Serena's existing upstream/package-manager recipe during an explicit install,
upgrade, or provisioning step. Leveret should not build a second downloader and must
not let a review trigger first-use acquisition. The bytes go directly from upstream
to the operator's private store, never into Leveret's npm package, container image,
release asset, mirror, proxy, or shared cache.

That is a useful engineering distinction from Leveret redistributing the bytes,
but it is not a legal safe harbor. The owner still makes a copy; Serena still uses
an upstream service; and the artifact's license may limit the user, machine,
product, purpose, or onward access. A direct URL does not create rights that the
artifact terms withhold.

Use the following acquisition tiers:

| Tier | Disposition | Leveret behavior |
|---|---|---|
| A | `bundle` / `bundle-with-obligations` | Publish the audited, pinned closure with its notices, SBOM, provenance, and redistribution obligations. |
| B | `serena-upstream-fetch` | After a recipe-specific license and service-terms review, explicitly authorize Serena's official package-manager or versioned-artifact mechanism into the owner's private store. Pin and verify the complete closure. |
| C | `serena-upstream-fetch-with-consent` | Before Serena makes any request, show the exact artifact, intended use, material restrictions, terms URL/version, and storage behavior; require an authorized owner to affirmatively accept. Never enable from pull-request configuration. |
| D | `user-provided` | Accept only a canonical path under an owner-controlled allowlisted root. Use this for account-, toolchain-, or permission-bound software and when no sanctioned automated interface exists. |
| E | `unavailable` | Do not download or launch it when the reviewed terms exclude Leveret's product/use context. A manual path or consent checkbox does not cure the restriction. |

Network acquisition is disabled until trusted owner configuration enables named
components; there is no blanket Serena-download switch inherited by every server.
Tier D is the default external disposition unless the exact component has separately
cleared Tier B or C. Documentation and installer diagnostics may point to an upstream
website without mirroring its files or accepting its terms for the operator.

The catalog therefore needs three independent decisions rather than overloading
`distribution`: whether Leveret may redistribute the artifact, which acquisition
channels upstream permits, and which deployment/use contexts the artifact permits.
Also record required acceptance (`none`, `affirmative`, or `external/BYOL`). One
green field cannot imply the others.

Tier B is appropriate for ordinary permissively licensed packages obtained via a
supported registry interface. npm's terms expressly permit package downloads via
the npm CLI and public APIs, but also say that packages are independently licensed;
registry availability is not a license grant ([npm Open-Source Terms](https://docs.npmjs.com/policies/open-source-terms/),
[npm license guidance](https://docs.npmjs.com/policies/npm-license/)). Python's
Simple Repository API similarly defines a supported package-discovery interface
and distribution hashes ([specification](https://packaging.python.org/en/latest/specifications/simple-repository-api/)).

Do not silently let Serena choose among these tiers. Serena 1.7.0 installs some
missing dependencies itself; Leveret must decide the tier before constructing that
adapter and either stage a bundled/fixed path, authorize that exact Serena recipe,
or keep the server offline. If Serena has no managed mechanism, Leveret does not
invent one under this policy; the operator supplies the toolchain/path.

## Reviewed proprietary cases

### Intelephense 1.14.4: permission-bound, not a general direct-fetch option

Serena runs `npm install intelephense@1.14.4` when the executable is absent
([adapter](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/intelephense.py)).
The official registry metadata pins the tarball and publishes SHA-512 integrity and
a signature, but names the package's included `LICENSE.txt` rather than an SPDX
license ([metadata](https://registry.npmjs.org/intelephense/1.14.4),
[package tarball](https://registry.npmjs.org/intelephense/-/intelephense-1.14.4.tgz)).

That included license says installation accepts the agreement, grants a personal,
non-transferable license, limits intended use to an individual end user paired with
an LSP-compatible IDE or text editor, and prohibits copying or distribution outside
that intended use. Premium features require a single-end-user key. It does **not**
expressly say that commercial work is prohibited; the material problem is the
individual/editor purpose and non-transferability. Whether a headless multi-user or
service-side review harness qualifies is unresolved and should not be assumed.

Disposition: **Tier D, permission-bound, pending legal/upstream approval**. Do not
offer a default `npm install` button and do not rely on Serena's automatic install.
An operator-provided path is usable only when the operator confirms that its exact
deployment has sufficient rights; hosted/multi-tenant use needs explicit legal or
licensor approval. Prefer the redistributable PHP backends already identified in
the [bundling audit](serena-lsp-bundling.md).

### Microsoft AL extension: blocked outside the licensed product context

Serena downloads `ms-dynamics-smb.al` version `18.0.2242655` from a Visual Studio
Marketplace gallery endpoint, checks a pinned SHA-256, extracts the VSIX, and starts
its bundled server directly
([adapter](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/al_language_server.py)).

Microsoft's current Marketplace terms permit acquisition only under the offering's
own terms, restrict Marketplace offerings to the named in-scope Microsoft products,
and require downloads to use publicly supported interfaces. They prohibit installing
or using Microsoft-published offerings in other products or services
([Marketplace terms, sections 1–3](https://aka.ms/vsmarketplace-ToU)). The AL listing
says the extension extends Visual Studio Code and is licensed for use with Dynamics
365 Business Central; for non-VS-Code compilation and packaging it directs users to
Microsoft's separate .NET development tools
([AL listing](https://marketplace.visualstudio.com/items?itemName=ms-dynamics-smb.al)).
The gallery endpoint's name contains `public`, but that alone does not prove it is a
publicly supported acquisition interface.

Disposition: **Tier E for the extracted AL language server**, unless Microsoft or
counsel confirms this use in writing. Neither a user-provided VSIX nor affirmative
acceptance removes the product-context restriction. Separately assess Microsoft's
documented .NET tooling as a possible supported integration; do not treat it as an
LSP-equivalent without a functional investigation.

### JetBrains Kotlin language server: direct-fetch candidate, then possible bundle

JetBrains publishes a standalone `262.9593.0` server for editors other than VS Code,
with platform-specific direct CDN links and SHA-256 files
([release](https://github.com/Kotlin/kotlin-lsp/releases/tag/kotlin-lsp%2Fv262.9593.0)).
The official README documents both Homebrew and manual installation and says the
server is designed for any LSP editor. It also says the implementation uses
proprietary JetBrains components and is partially closed-source
([README](https://github.com/Kotlin/kotlin-lsp)). Serena's pinned adapter restricts
downloads to JetBrains' CDN and verifies the default release against its own hash
database
([adapter](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/language_servers/kotlin_language_server.py),
[hashes](https://github.com/oraios/serena/blob/v1.7.0/src/solidlsp/resources/downloaded_dependency_hashes.json)).
The exact tag carries Apache-2.0, and JetBrains' own Homebrew formula also declares
Apache-2.0 while pinning first-party URLs and hashes
([tag license](https://github.com/Kotlin/kotlin-lsp/blob/kotlin-lsp/v262.9593.0/LICENSE.txt),
[formula](https://github.com/JetBrains/homebrew-utils/blob/master/Formula/kotlin-lsp.rb)).

The VS Code extension is a different artifact and changed to the JetBrains Free
Plugin License. That license accepts an individual **or legal entity**, permits
commercial and non-commercial use, treats downloading/installing as acceptance, and
prohibits transfer or providing the plugin/use of it to a third party
([official terms](https://www.jetbrains.com/legal/docs/terms/jetbrains-free-plugin-license/1.0/)).
Do not import those terms into the standalone classification without evidence, and
never substitute the Marketplace VSIX for the standalone archive.

Disposition: **Tier B now, and a Tier A candidate after exact archive inventory**.
Official standalone purpose, first-party URLs/checksums, Apache-2.0 tag and formula,
and Serena's existing pinned download make operator-enabled acquisition supportable
without inventing a clickthrough or a separate downloader. Before Leveret
redistributes the archive, inspect its embedded licenses/notices and transitive
closed components. The repository license alone is not a complete binary-closure
audit.

## Consent and acquisition receipt

For Tier C, an interactive installer must require a distinct acceptance for the
exact component and terms revision. Non-interactive/container/GitHub Actions use
must name that acceptance explicitly in trusted owner configuration; a generic
`--yes`, environment inherited from the reviewed checkout, or Serena's implicit
download is insufficient.

Store an owner-controlled receipt containing:

- component, version, platform, architecture, upstream URL, final URL, and hashes;
- artifact license/terms URL, effective date or version, and content digest;
- material use limits shown to the owner and the selected deployment context;
- acceptance identity/source, timestamp, installer and Serena versions, result, and
  private storage path;
- redirect chain, fetched byte count, verification result, and any policy gap.

Consent records evidence a decision; they do not expand the license. Tier B still
gets the acquisition/provenance fields but normally needs no component-specific
clickthrough. If upstream terms change, the digest changes and the recipe returns to
review before download or upgrade.

## Storage and redistribution boundary

- Download only from the owner's machine/runner to an owner-controlled private
  store. Leveret must not proxy, mirror, seed, attach, or serve proprietary bytes.
- A container image built with the bytes, an npm/release artifact containing them,
  or a cache shared with other owners is redistribution-sensitive and cannot use the
  direct-fetch classification.
- A private GitHub Actions cache/artifact is still a stored copy governed by the
  upstream terms. Do not upload proprietary server directories by default. If an
  owner enables persistence, record visibility/retention and prevent publication or
  cross-tenant reuse.
- Backups, warm caches, and a hosted service's node image are copies too. Separate
  host-local convenience from anything delivered to another legal person.
- Users may always disable downloads, choose individual components, supply paths,
  or force offline operation. Missing components degrade only their languages.

## Security requirements

Every Tier B/C recipe must be host-authored and versioned with Leveret, never read
from the pull-request checkout. It must use HTTPS, an exact version and platform,
an allowlisted upstream host, bounded redirects and size, and a pinned cryptographic
hash from first-party metadata plus Leveret's reviewed catalog. Download to a new
temporary directory, verify before extraction, reject traversal/absolute paths,
links and special files escaping the destination, then atomically install below the
owner's persistent Serena root.

Package managers run untrusted package code. Use a pinned client and lock/verify the
full transitive closure, disable lifecycle/build scripts where the package works
without them, and otherwise run acquisition in a network/filesystem/credential
sandbox. npm supports frozen automated installs with `npm ci`
([documentation](https://docs.npmjs.com/cli/commands/npm-ci/)); pip's secure mode
requires hashes for the complete dependency set and can reject source distributions
([documentation](https://pip.pypa.io/en/stable/topics/secure-installs/)). A top-level
version alone is not reproducible or sufficient.

Downloaded executables must resolve to canonical paths below the trusted store and
run with the same credential isolation, checkout-as-data rule, and sandbox policy as
bundled servers. Log attempts and outcomes without credentials, license keys, proxy
secrets, or private registry tokens.

## Questions requiring legal or upstream confirmation

1. Does Intelephense authorize headless, organizational, CI, or review-service use;
   can Leveret offer an automated install recipe; and what license covers multiple
   reviewers or tenants?
2. Is JetBrains' standalone archive entirely Apache-2.0 or compatibly licensed, or
   does it embed additional terms that distinguish internal, hosted, or multi-tenant
   use?
3. Can Microsoft's AL server be used outside Visual Studio Code through a third-party
   LSP client, and is its gallery package endpoint a publicly supported interface?
4. When do owner-private CI caches, backups, machine images, and internal shared
   stores become a prohibited transfer or distribution for each proprietary server?
5. What evidence of authority and acceptance is sufficient when an administrator
   installs for a legal entity, and which jurisdictions require a different flow?

Until answered, classify uncertainty conservatively. “The operator downloaded it”
is provenance, not permission.
