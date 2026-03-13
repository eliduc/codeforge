# CodeForge Snapshot Script for Windows (PowerShell)
# Usage: .\snapshot.ps1 [snapshot_name] [description]

param(
    [string]$SnapshotName = "",
    [string]$Description = "Manual snapshot before changes"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$SnapshotsDir = Join-Path $ProjectDir "snapshots"

# Create snapshots directory
if (-not (Test-Path $SnapshotsDir)) {
    New-Item -ItemType Directory -Path $SnapshotsDir | Out-Null
}

# Generate timestamp and name
$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
if ([string]::IsNullOrEmpty($SnapshotName)) {
    $SnapshotName = "snapshot_$Timestamp"
}

$SnapshotFile = Join-Path $SnapshotsDir "$SnapshotName.zip"
$MetadataFile = Join-Path $SnapshotsDir "$SnapshotName.meta"

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "CodeForge Snapshot Tool" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Creating snapshot: $SnapshotName" -ForegroundColor Yellow
Write-Host "Location: $SnapshotFile"
Write-Host "Project:  $ProjectDir"
Write-Host ""

# Create metadata
$metadata = @"
# CodeForge Snapshot Metadata
name=$SnapshotName
timestamp=$Timestamp
date=$(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
description=$Description
"@
$metadata | Out-File -FilePath $MetadataFile -Encoding UTF8

# Patterns to exclude
$excludePatterns = @(
    "*\node_modules\*",
    "*\dist\*",
    "*\__pycache__\*",
    "*\.git\*",
    "*\snapshots\*",
    "*.pyc",
    "*\.env",
    "*.log"
)

# Create temp directory for staging
$tempDir = Join-Path $env:TEMP "codeforge_snapshot_$Timestamp"
if (Test-Path $tempDir) { Remove-Item -Recurse -Force $tempDir }
New-Item -ItemType Directory -Path $tempDir | Out-Null

Write-Host "Collecting files..." -ForegroundColor Gray

# Function to check if path should be excluded
function Test-Excluded {
    param([string]$Path)
    foreach ($pattern in $excludePatterns) {
        if ($Path -like $pattern) { return $true }
    }
    return $false
}

# Function to copy directory recursively with exclusions
function Copy-FilteredDirectory {
    param(
        [string]$Source,
        [string]$Destination
    )
    
    if (-not (Test-Path $Source)) {
        Write-Host "  SKIP (not found): $Source" -ForegroundColor DarkGray
        return
    }
    
    $files = Get-ChildItem -Path $Source -Recurse -File -ErrorAction SilentlyContinue
    $count = 0
    
    foreach ($file in $files) {
        if (Test-Excluded $file.FullName) { continue }
        
        $relativePath = $file.FullName.Substring($Source.Length).TrimStart('\')
        $targetPath = Join-Path $Destination $relativePath
        $targetDir = Split-Path -Parent $targetPath
        
        if (-not (Test-Path $targetDir)) {
            New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
        }
        
        Copy-Item $file.FullName -Destination $targetPath -Force
        $count++
    }
    
    Write-Host "  $Source -> $count files" -ForegroundColor Gray
}

# Function to copy single file
function Copy-SingleFile {
    param(
        [string]$Source,
        [string]$Destination
    )
    
    if (-not (Test-Path $Source)) {
        Write-Host "  SKIP (not found): $Source" -ForegroundColor DarkGray
        return
    }
    
    $targetDir = Split-Path -Parent $Destination
    if (-not (Test-Path $targetDir)) {
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    }
    
    Copy-Item $Source -Destination $Destination -Force
    Write-Host "  $Source -> copied" -ForegroundColor Gray
}

# Copy directories
Copy-FilteredDirectory (Join-Path $ProjectDir "backend\app") (Join-Path $tempDir "backend\app")
Copy-FilteredDirectory (Join-Path $ProjectDir "backend\alembic") (Join-Path $tempDir "backend\alembic")
Copy-FilteredDirectory (Join-Path $ProjectDir "frontend\src") (Join-Path $tempDir "frontend\src")
Copy-FilteredDirectory (Join-Path $ProjectDir "frontend\public") (Join-Path $tempDir "frontend\public")
Copy-FilteredDirectory (Join-Path $ProjectDir "scripts") (Join-Path $tempDir "scripts")
Copy-FilteredDirectory (Join-Path $ProjectDir "sandbox") (Join-Path $tempDir "sandbox")

# Copy individual files
Copy-SingleFile (Join-Path $ProjectDir "backend\Dockerfile") (Join-Path $tempDir "backend\Dockerfile")
Copy-SingleFile (Join-Path $ProjectDir "backend\requirements.txt") (Join-Path $tempDir "backend\requirements.txt")
Copy-SingleFile (Join-Path $ProjectDir "backend\pyproject.toml") (Join-Path $tempDir "backend\pyproject.toml")
Copy-SingleFile (Join-Path $ProjectDir "backend\alembic.ini") (Join-Path $tempDir "backend\alembic.ini")
Copy-SingleFile (Join-Path $ProjectDir "frontend\Dockerfile") (Join-Path $tempDir "frontend\Dockerfile")
Copy-SingleFile (Join-Path $ProjectDir "frontend\package.json") (Join-Path $tempDir "frontend\package.json")
Copy-SingleFile (Join-Path $ProjectDir "frontend\package-lock.json") (Join-Path $tempDir "frontend\package-lock.json")
Copy-SingleFile (Join-Path $ProjectDir "frontend\tsconfig.json") (Join-Path $tempDir "frontend\tsconfig.json")
Copy-SingleFile (Join-Path $ProjectDir "frontend\tsconfig.node.json") (Join-Path $tempDir "frontend\tsconfig.node.json")
Copy-SingleFile (Join-Path $ProjectDir "frontend\vite.config.ts") (Join-Path $tempDir "frontend\vite.config.ts")
Copy-SingleFile (Join-Path $ProjectDir "frontend\tailwind.config.js") (Join-Path $tempDir "frontend\tailwind.config.js")
Copy-SingleFile (Join-Path $ProjectDir "frontend\postcss.config.js") (Join-Path $tempDir "frontend\postcss.config.js")
Copy-SingleFile (Join-Path $ProjectDir "frontend\index.html") (Join-Path $tempDir "frontend\index.html")
Copy-SingleFile (Join-Path $ProjectDir "docker-compose.yml") (Join-Path $tempDir "docker-compose.yml")
Copy-SingleFile (Join-Path $ProjectDir "Makefile") (Join-Path $tempDir "Makefile")
Copy-SingleFile (Join-Path $ProjectDir "README.md") (Join-Path $tempDir "README.md")

Write-Host ""
Write-Host "Creating archive..." -ForegroundColor Gray

# Create ZIP archive
if (Test-Path $SnapshotFile) { Remove-Item $SnapshotFile -Force }
Compress-Archive -Path "$tempDir\*" -DestinationPath $SnapshotFile -CompressionLevel Optimal

# Cleanup temp directory
Remove-Item -Recurse -Force $tempDir

# Get file size
$size = (Get-Item $SnapshotFile).Length
$sizeKB = [math]::Round($size / 1KB, 2)
$sizeMB = [math]::Round($size / 1MB, 2)

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "Snapshot created successfully!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
Write-Host "Files:"
Write-Host "  Archive:  $SnapshotFile"
Write-Host "  Metadata: $MetadataFile"
Write-Host ""
Write-Host "Size: $sizeMB MB ($sizeKB KB)"
Write-Host ""
Write-Host "To restore, run:" -ForegroundColor Yellow
Write-Host "  powershell -ExecutionPolicy Bypass -File .\scripts\restore.ps1 $SnapshotName" -ForegroundColor Yellow
Write-Host ""

# List recent snapshots
Write-Host "Recent snapshots:" -ForegroundColor Cyan
Get-ChildItem -Path $SnapshotsDir -Filter "*.zip" -ErrorAction SilentlyContinue | 
    Sort-Object LastWriteTime -Descending | 
    Select-Object -First 5 | 
    ForEach-Object { 
        $sizeMB = [math]::Round($_.Length / 1MB, 2)
        Write-Host ("  {0} ({1:N2} MB)" -f $_.BaseName, $sizeMB)
    }
