@echo off
echo ========================================
echo CodeForge Setup for Windows (Conda)
echo ========================================
echo.

REM Check if .env exists
if not exist .env (
    echo Creating .env from .env.example...
    copy .env.example .env
    echo.
    echo IMPORTANT: Edit .env file and add your API keys!
    echo Press any key after editing .env...
    notepad .env
    pause >nul
)

echo.
echo Building Docker images...
docker-compose build

echo.
echo Building sandbox image...
docker build -t codeforge-python-sandbox:latest ./sandbox

echo.
echo Starting services...
docker-compose up -d

echo.
echo Waiting for services to start...
timeout /t 10 /nobreak >nul

echo.
echo ========================================
echo CodeForge is running!
echo ========================================
echo.
echo   Frontend: http://localhost:3000
echo   Backend:  http://localhost:8000
echo   API Docs: http://localhost:8000/docs
echo.
echo To stop: docker-compose down
echo To view logs: docker-compose logs -f
echo.
pause
