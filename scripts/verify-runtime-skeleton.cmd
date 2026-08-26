@echo off
setlocal
cd /d "%~dp0\.."
echo [1/6] syntax: main.js
node --check resources\app\main.js || exit /b 1
echo [2/6] syntax: runtime modules
node --check resources\app\services\runtime\index.js || exit /b 1
node --check resources\app\services\runtime\openclaw-runtime.js || exit /b 1
node --check resources\app\services\runtime\runtime-factory.js || exit /b 1
node --check resources\app\services\runtime\runtime-port.js || exit /b 1
node --check resources\app\services\agent-services.js || exit /b 1
echo [3/6] test: agent-runtime-skeleton-test
node resources\app\tests\agent-runtime-skeleton-test.js || exit /b 1
echo [4/6] test: default-relay-provider-test
node resources\app\tests\default-relay-provider-test.js || exit /b 1
echo [5/6] test: default-relay-settings-test
if exist resources\app\tests\default-relay-settings-test.js (
  node resources\app\tests\default-relay-settings-test.js || exit /b 1
) else (
  echo skip default-relay-settings-test
)
echo [6/6] ALL_OK
exit /b 0
