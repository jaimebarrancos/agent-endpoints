not having uniswap v3 on base sepolia


Running on Mac M2:
```
git clone https://github.com/Uniswap/v3-subgraph.git
cd v3-subgraph
npm install
```
Errors:
```
Cloning into 'v3-subgraph'...
remote: Enumerating objects: 4061, done.
remote: Counting objects: 100% (187/187), done.
remote: Compressing objects: 100% (82/82), done.
remote: Total 4061 (delta 146), reused 119 (delta 105), pack-reused 3874 (from 4)
Receiving objects: 100% (4061/4061), 1.98 MiB | 6.65 MiB/s, done.
Resolving deltas: 100% (2263/2263), done.
npm error code ERESOLVE
npm error ERESOLVE unable to resolve dependency tree
npm error
npm error While resolving: uniswap-v3-subgraph@1.0.0
npm error Found: eslint@8.57.1
npm error node_modules/eslint
npm error   dev eslint@"^8.57.0" from the root project
npm error
npm error Could not resolve dependency:
npm error peer eslint@"^5.0.0 || ^6.0.0" from @typescript-eslint/parser@2.34.0
npm error node_modules/@typescript-eslint/parser
npm error   dev @typescript-eslint/parser@"^2.0.0" from the root project
npm error   peer @typescript-eslint/parser@"^2.0.0" from @typescript-eslint/eslint-plugin@2.34.0
npm error   node_modules/@typescript-eslint/eslint-plugin
npm error     dev @typescript-eslint/eslint-plugin@"^2.0.0" from the root project
npm error
npm error Fix the upstream dependency conflict, or retry this command with --force or --legacy-peer-deps to accept an incorrect (and potentially broken) dependency resolution.
npm error
npm error
npm error For a full report see:
npm error /Users/jaimebarrancos/.npm/_logs/2026-07-25T13_25_42_907Z-eresolve-report.txt
npm error A complete log of this run can be found in: /Users/jaimebarrancos/.npm/_logs/2026-07-25T13_25_42_907Z-debug-0.log
```