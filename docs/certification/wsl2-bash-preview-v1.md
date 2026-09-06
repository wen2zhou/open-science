# WSL2 Bash Preview v1 certification

Status: certified for explicit Preview opt-in on Windows x64

Certification date: 2026-09-06

Application version: 0.25.1

## Certified reference configuration

This record describes one privacy-safe reference configuration. It intentionally omits account
names, full host paths, credentials, user commands, and command output.

| Component                | Certified value                                     |
| ------------------------ | --------------------------------------------------- |
| Application              | Open Science 0.25.1, Windows x64 package            |
| Windows-reported product | Windows 11 Pro (CIM), 25H2, build 26200.9168, AMD64 |
| WSL                      | 2.1.5.0                                             |
| WSL kernel package       | 5.15.146.1-2                                        |
| Guest kernel             | 5.15.146.1-microsoft-standard-WSL2                  |
| WSLg                     | 1.0.60                                              |
| MSRDC                    | 1.2.5105                                            |
| Direct3D                 | 1.611.1-81528511                                    |
| DXCore                   | 10.0.25131.1002-220531-1700.rs-onecore-base2-hyp    |
| Distribution             | Ubuntu-22.04, Ubuntu 22.04.5 LTS, WSL version 2     |
| Guest profile            | Dedicated non-root profile, UID 1000                |
| Bash                     | GNU bash 5.1.16(1)-release, x86_64                  |
| bubblewrap               | 0.6.1                                               |
| WSL networking           | Mirrored (`networkingMode=mirrored`)                |

## Package evidence

| Field                             | Value                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------ |
| Installer                         | `aipoch-open-science-0.25.1-win-x64-setup.exe`                                 |
| Size                              | 193,917,606 bytes                                                              |
| SHA-256                           | `695FEF110B9EEC3F1E0FB78CCA283F5EE8A9FAA947B88782CDC8096144B4180C`             |
| Packaged Preview manifest         | Schema 1; app version 0.25.1                                                   |
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

The final installer smoke completed in 44.44 seconds from application-source checkpoint `17afa494`
using harness checkpoint `18be94cb`. Package inspection found exactly one Windows Prisma engine,
all three manifest assets, and no private worktree, scratch, test runtime, report, or legacy output
entries. The current review and broad-suite limitations are recorded in
`wsl2-release-readiness-2026-09-06.md`.

The same final package passed the Settings UI journey. All eight readiness rows succeeded against
the real reference profile. Explicit WSL2 activation survived an application restart; switching to
PowerShell also survived a restart while preserving the saved WSL profile. The renderer reported no
errors, and no application processes remained after the journey.

The smoke used its explicit retention mode because AppContainer teardown requires interactive UAC
approval. Its test-owned installation, uninstaller, and two matching registrations remain retained
with no related processes running. Complete teardown must use the retained product uninstaller with
administrator approval so the owned AppContainer resources are also removed; deleting only files
or registration would strand them. Administrator-only cleanup remains a host limitation and is not
part of the WSL2 Preview verdict.

## Gate A evidence

The real-host WSL suite passed 12 of 12 integration tests on the reference configuration. It covered
bounded execution and non-zero exits; allowed and denied filesystem access; mirrored-network allow
and deny paths; Windows/WSL environment translation and cleanup; cancellation; timeout; descendant
termination; concurrent commands; exact v1 command-UUID temporary roots and receipts; successful
receipt reconciliation; and malformed-receipt fail-closed behavior.

The added real-adapter regression verifies that a read-only input nested under a writable parent
stays read-only and that a narrower writable grant cannot reopen a denied ancestor.

Focused negative tests also passed for missing WSL, bubblewrap, or absolute `/usr/bin/python3`
dependencies, WSL1, root profiles,
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
