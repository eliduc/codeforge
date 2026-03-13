# CodeForge Restore Script for Windows (PowerShell)
# Usage: .\restore.ps1 [snapshot_name]

param(
    [string]$SnapshotName = ""
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$SnapshotsDir = Join-Path $ProjectDir "snapshots"

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "CodeForge Restore Tool" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# List available snapshots if no name provided
if ([string]::IsNullOrEmpty($SnapshotName)) {
    Write-Host "Available snapshots:" -ForegroundColor Yellow
    Write-Host ""
    
    $snapshots = Get-ChildItem -Path $SnapshotsDir -Filter "*.zip" -ErrorAction SilentlyContinue | 
        Sort-Object LastWriteTime -Descending
    
    if ($snapshots.Count -eq 0) {
        Write-Host "  No snapshots found in $SnapshotsDir" -ForegroundColor Red
        Write-Host ""
        exit 1
    }
    
    foreach ($snap in $snapshots) {
        $name = $snap.BaseName
        $metaFile = Join-Path $SnapshotsDir "$name.meta"
        $date = $snap.LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss")
        $sizeMB = [math]::Round($snap.Length / 1MB, 2)
        $desc = "No description"
        
        if (Test-Path $metaFile) {
            $metaContent = Get-Content $metaFile -Raw -ErrorAction SilentlyContinue
            if ($metaContent -match "description=(.+)") {
                $desc = $Matches[1].Trim()
            }
        }
        
        Write-Host "  $name" -ForegroundColor White
        Write-Host "    Date: $date"
        Write-Host "    Size: $sizeMB MB"
        Write-Host "    Desc: $desc"
        Write-Host ""
    }
    
    Write-Host "Usage:" -ForegroundColor Yellow
    Write-Host "  powershell -ExecutionPolicy Bypass -File .\scripts\restore.ps1 <snapshot_name>"
    Write-Host ""
    exit 0
}

$SnapshotFile = Join-Path $SnapshotsDir "$SnapshotName.zip"
$MetadataFile = Join-Path $SnapshotsDir "$SnapshotName.meta"

# Check if snapshot exists
if (-not (Test-Path $SnapshotFile)) {
    Write-Host "ERROR: Snapshot not found: $SnapshotFile" -ForegroundColor Red
    Write-Host ""
    Write-Host "Available snapshots:" -ForegroundColor Yellow
    Get-ChildItem -Path $SnapshotsDir -Filter "*.zip" -ErrorAction SilentlyContinue | 
        ForEach-Object { Write-Host "  $($_.BaseName)" }
    exit 1
}

# Show metadata
if (Test-Path $MetadataFile) {
    Write-Host "Snapshot details:" -ForegroundColor Cyan
    Get-Content $MetadataFile | Where-Object { $_ -match "^(date|description)=" } | 
        ForEach-Object { Write-Host "  $_" }
    Write-Host ""
}

# Confirm restore
Write-Host "WARNING: This will overwrite current project files!" -ForegroundColor Red
Write-Host ""
$confirm = Read-Host "Are you sure you want to restore '$SnapshotName'? [y/N]"

if ($confirm -notmatch "^[Yy]$") {
    Write-Host "Restore cancelled." -ForegroundColor Yellow
    exit 0
}

# Stop Docker containers
Write-Host ""
Write-Host "Stopping Docker containers..." -ForegroundColor Gray
Push-Location $ProjectDir
try {
    docker compose down 2>$null
} catch {}

# Create backup of current state
$BackupName = "pre_restore_$(Get-Date -Format 'yyyyMMdd_HHmmss')"
Write-Host "Creating backup of current state: $BackupName" -ForegroundColor Yellow
try {
    & "$ScriptDir\snapshot.ps1" -SnapshotName $BackupName -Description "Auto-backup before restore from $SnapshotName" 2>$null
} catch {
    Write-Host "  Warning: Could not create backup" -ForegroundColor DarkYellow
}

# Restore files
Write-Host ""
Write-Host "Restoring files from snapshot..." -ForegroundColor Gray

# Remove current directories that will be restored
$dirsToRemove = @(
    "backend\app",
    "backend\alembic",
    "frontend\src",
    "frontend\public",
    "scripts",
    "sandbox"
)

foreach ($dir in $dirsToRemove) {
    $fullPath = Join-Path $ProjectDir $dir
    if (Test-Path $fullPath) {
        Write-Host "  Removing: $dir" -ForegroundColor DarkGray
        Remove-Item -Recurse -Force $fullPath -ErrorAction SilentlyContinue
    }
}

# Extract snapshot
Write-Host "  Extracting archive..." -ForegroundColor Gray
Expand-Archive -Path $SnapshotFile -DestinationPath $ProjectDir -Force

Pop-Location

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "Restore completed!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Rebuild containers: docker compose build --no-cache"
Write-Host "  2. Start services:     docker compose up -d"
Write-Host ""
Write-Host "Previous state backed up as: $BackupName" -ForegroundColor Cyan
Write-Host ""
