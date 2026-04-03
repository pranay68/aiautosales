param(
  [string]$ResourceGroup = "rg-aiautosales-freeswitch",
  [string]$Location = "eastus",
  [string]$VmName = "aiautosales-freeswitch",
  [string]$DnsLabel = "aiautosales-freeswitch",
  [string]$VmSize = "Standard_D2s_v5",
  [string]$BridgeGatewayPublicBaseUrl = "",
  [string]$AdminPassword = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($BridgeGatewayPublicBaseUrl)) {
  throw "BridgeGatewayPublicBaseUrl is required. Pass the public HTTPS URL for bridge-gateway."
}

if ([string]::IsNullOrWhiteSpace($AdminPassword)) {
  throw "AdminPassword is required. Pass a strong temporary password for the VM admin user."
}

az group create `
  --name $ResourceGroup `
  --location $Location | Out-Null

az deployment group create `
  --resource-group $ResourceGroup `
  --template-file infra/azure/freeswitch/main.bicep `
  --parameters `
    location=$Location `
    vmName=$VmName `
    dnsLabel=$DnsLabel `
    vmSize=$VmSize `
    bridgeGatewayPublicBaseUrl=$BridgeGatewayPublicBaseUrl `
    adminPassword="$AdminPassword" | Out-Host
