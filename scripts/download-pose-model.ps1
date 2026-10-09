$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ModelDirectory = Join-Path $ProjectRoot "public\models"
$ModelPath = Join-Path $ModelDirectory "pose_landmarker_lite.task"
$TemporaryPath = Join-Path ([System.IO.Path]::GetTempPath()) "resq-pose-model-$([guid]::NewGuid().ToString('N')).download"
$ModelUrl = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task"
$ExpectedLength = 5777746
$ExpectedSha256 = "59929E1D1EE95287735DDD833B19CF4AC46D29BC7AFDDBBF6753C459690D574A"

New-Item -ItemType Directory -Force -Path $ModelDirectory | Out-Null
try {
    Write-Host "Downloading the official MediaPipe Pose Landmarker Lite model..."
    Invoke-WebRequest -Uri $ModelUrl -OutFile $TemporaryPath -UseBasicParsing

    $File = Get-Item $TemporaryPath
    $Hash = (Get-FileHash $TemporaryPath -Algorithm SHA256).Hash
    if ($File.Length -ne $ExpectedLength -or $Hash -ne $ExpectedSha256) {
        throw "The downloaded artifact did not match the reviewed model checksum. It was not installed."
    }

    Move-Item -Force $TemporaryPath $ModelPath
    Write-Host "Verified model installed at public\models\pose_landmarker_lite.task"
    Write-Host "SHA256: $Hash"
}
catch {
    if (Test-Path $TemporaryPath) {
        Remove-Item -LiteralPath $TemporaryPath -Force
    }
    throw
}
