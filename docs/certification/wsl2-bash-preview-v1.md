# WSL2 Bash Preview v1 certification

Status: certified for explicit Preview opt-in on Windows x64

Certification date: 2026-09-03

Application version: 0.24.0

## Certified reference configuration

This record describes one privacy-safe reference configuration. It intentionally omits account
names, full host paths, credentials, user commands, and command output.

| Component                | Certified value                                   |
| ------------------------ | ------------------------------------------------- |
| Application              | Open Science 0.24.0, Windows x64 package          |
| Windows-reported product | Windows 10 Pro, version 2009, build 26200, 64-bit |
| WSL                      | 2.1.5.0                                           |
| WSL kernel package       | 5.15.146.1-2                                      |
| Guest kernel             | 5.15.146.1-microsoft-standard-WSL2                |
| WSLg                     | 1.0.60                                            |
| MSRDC                    | 1.2.5105                                          |
| Direct3D                 | 1.611.1-81528511                                  |
| DXCore                   | 10.0.25131.1002-220531-1700.rs-onecore-base2-hyp  |
| Distribution             | Ubuntu-22.04, Ubuntu 22.04.5 LTS, WSL version 2   |
| Guest profile            | Dedicated non-root profile, UID 1000              |
| Bash                     | GNU bash 5.1.16(1)-release, x86_64                |
| bubblewrap               | 0.6.1                                             |
| WSL networking           | Mirrored (`networkingMode=mirrored`)              |

## Package evidence

| Field                             | Value                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------ |
| Installer                         | `aipoch-open-science-0.24.0-win-x64-setup.exe`                                 |
| Size                              | 194,280,037 bytes                                                              |
| SHA-256                           | `ECABCAB4706B72EB7B6E1CAFDFB006CE9DDE7C7B716BDA6EBCD58CF67061A0B5`             |
| Packaged Preview manifest         | Schema 1; app version 0.24.0                                                   |
| Required asset identities         | `wsl2-execution-wrapper-v1`, `wsl2-exact-cleanup-v1`, `wsl2-network-bridge-v1` |
| Packaged micromamba               | 2.8.1                                                                          |
| Packaged compatibility micromamba | 1.5.12                                                                         |

The exact Windows installer smoke passed installation, packaged-resource and app-version
validation, local RPC, first initialization, runtime redetection, installed-app restart, fresh and
legacy database opens, and paths containing spaces and non-ASCII characters. After the first
packaged launch, the smoke created one exact schema-v1 WSL2 command temporary root and matching
ownership receipt. The next installed-app restart ran the packaged main process's real
`NotebookNetworkSandboxOwner` reconciliation and removed both pieces of matching evidence without
spawning a user command. A separate malformed receipt then made packaged startup fail closed during
sandbox preparation and remained intact; removing only that test-owned malformed evidence restored
a healthy restart.

The smoke used its explicit retention mode because AppContainer teardown requires interactive UAC
approval. Its test-owned installation files and registration were removed after evidence
collection; administrator-only AppContainer cleanup remains a host limitation and is not part of
the WSL2 Preview verdict.

## Gate A evidence

The real-host WSL suite passed 11 of 11 integration tests on the reference configuration. It covered
bounded execution and non-zero exits; allowed and denied filesystem access; mirrored-network allow
and deny paths; Windows/WSL environment translation and cleanup; cancellation; timeout; descendant
termination; concurrent commands; exact v1 command-UUID temporary roots and receipts; successful
receipt reconciliation; and malformed-receipt fail-closed behavior.

Focused negative tests also passed for missing WSL or bubblewrap dependencies, WSL1, root profiles,
unsupported or non-local workspace paths, non-mirrored networking, sandbox startup failure, missing
packaged assets, asset/app-version mismatch, non-Windows platforms, non-x64 architectures, and the
build-level rollback switch. Every negative case keeps PowerShell selected or returns an explicit
unavailable result.

The runtime relies on the desktop application's existing single-instance contract. This Preview
does not add a cross-process sandbox fence.

## Gate B release controls

PowerShell remains the default. The WSL2 Bash entry is labelled Preview and is exposed only when the
main process certifies Windows x64, the build-level Preview switch, and the packaged asset manifest.
Activation remains explicit and requires the latest readiness selection plus sandbox checks.
Unavailable and out-of-scope states fail closed while preserving retry, support-conversation, and
explicit PowerShell recovery paths. New renderer copy is present in all eight translated locales.

Rollback is a new build with the WSL2 Bash Preview build switch disabled. There is no runtime
environment gate, remote rollout flag, or Preview telemetry.

## Limits of this certification

This record is not a production-readiness claim and does not certify default NAT networking, a broad
Windows/WSL version matrix, other Linux distributions, ARM64, UNC or other non-local paths,
cross-application process fencing, or general availability on other platforms. Those configurations
remain unavailable or fail closed.
