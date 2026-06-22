-- =============================================================
-- GameUI.client.lua
-- Runs on EACH player's screen (the "client").
-- This script only handles visuals — it never makes game
-- decisions. It waits for the server to send messages, then
-- updates the labels on screen.
-- =============================================================

local Players           = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService      = game:GetService("TweenService")

local localPlayer = Players.LocalPlayer


-- =============================================================
-- WAIT FOR REMOTE EVENTS
-- The server creates these before any client runs, but we use
-- WaitForChild just in case of a tiny timing difference.
-- The "10" means: give up after 10 seconds and print an error.
-- =============================================================
local remoteFolder = ReplicatedStorage:WaitForChild("TagGameRemotes", 10)
if not remoteFolder then
    warn("[GameUI] Could not find TagGameRemotes folder! Is GameManager running?")
    return
end

local RoundUpdate  = remoteFolder:WaitForChild("RoundUpdate", 10)
local InfectNotify = remoteFolder:WaitForChild("InfectNotify", 10)


-- =============================================================
-- BUILD THE UI IN CODE
-- We create everything here so you don't have to set anything
-- up manually in Studio — just sync with Rojo and it appears.
-- =============================================================

-- ScreenGui: the invisible container that holds all 2D elements
local screenGui = Instance.new("ScreenGui")
screenGui.Name         = "TagGameUI"
screenGui.ResetOnSpawn = false  -- keep the UI alive when the player respawns
screenGui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
screenGui.Parent       = localPlayer:WaitForChild("PlayerGui")


-- ---- STATUS BAR (top centre) ----
-- Shows round phase info: countdown numbers, time remaining, winner name
local statusFrame = Instance.new("Frame")
statusFrame.Name              = "StatusFrame"
statusFrame.Size              = UDim2.new(0.55, 0, 0, 52)
statusFrame.Position          = UDim2.new(0.225, 0, 0.03, 0)
statusFrame.BackgroundColor3  = Color3.fromRGB(20, 20, 20)
statusFrame.BackgroundTransparency = 0.3
statusFrame.BorderSizePixel   = 0
statusFrame.Parent            = screenGui

local statusCorner = Instance.new("UICorner")
statusCorner.CornerRadius = UDim.new(0, 10)
statusCorner.Parent       = statusFrame

local statusLabel = Instance.new("TextLabel")
statusLabel.Name             = "StatusLabel"
statusLabel.Size             = UDim2.new(1, -16, 1, 0)
statusLabel.Position         = UDim2.new(0, 8, 0, 0)
statusLabel.BackgroundTransparency = 1
statusLabel.TextColor3       = Color3.fromRGB(255, 255, 255)
statusLabel.TextScaled       = true
statusLabel.Font              = Enum.Font.GothamBold
statusLabel.Text              = "Connecting..."
statusLabel.Parent            = statusFrame


-- ---- PERSONAL NOTIFICATION (middle of screen) ----
-- Pops up to tell THIS player something: "You're infected!" or
-- the winner message. Fades out automatically after a few seconds.
local notifyFrame = Instance.new("Frame")
notifyFrame.Name             = "NotifyFrame"
notifyFrame.Size             = UDim2.new(0.5, 0, 0, 68)
notifyFrame.Position         = UDim2.new(0.25, 0, 0.44, 0)
notifyFrame.BackgroundColor3 = Color3.fromRGB(180, 0, 0)
notifyFrame.BackgroundTransparency = 1  -- start hidden
notifyFrame.BorderSizePixel  = 0
notifyFrame.Parent           = screenGui

local notifyCorner = Instance.new("UICorner")
notifyCorner.CornerRadius = UDim.new(0, 10)
notifyCorner.Parent       = notifyFrame

local notifyLabel = Instance.new("TextLabel")
notifyLabel.Name             = "NotifyLabel"
notifyLabel.Size             = UDim2.new(1, -16, 1, 0)
notifyLabel.Position         = UDim2.new(0, 8, 0, 0)
notifyLabel.BackgroundTransparency = 1
notifyLabel.TextColor3       = Color3.fromRGB(255, 255, 255)
notifyLabel.TextTransparency = 1  -- start invisible
notifyLabel.TextScaled       = true
notifyLabel.Font              = Enum.Font.GothamBold
notifyLabel.Text              = ""
notifyLabel.Parent            = notifyFrame


-- =============================================================
-- HELPER: setStatusColour
-- Changes the status bar colour to match the current game phase.
-- =============================================================
local function setStatusColour(colour)
    -- Smooth colour transition using TweenService
    local info  = TweenInfo.new(0.3, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
    local tween = TweenService:Create(statusFrame, info, { BackgroundColor3 = colour })
    tween:Play()
end


-- =============================================================
-- HELPER: showNotification
-- Flashes a popup in the middle of the screen, then fades it out.
-- bgColour: a Color3 for the notification's background
-- duration: how long (seconds) before it starts fading
-- =============================================================
local function showNotification(message, bgColour, duration)
    duration = duration or 2.5

    notifyLabel.Text          = message
    notifyFrame.BackgroundColor3 = bgColour

    -- Snap to visible
    notifyFrame.BackgroundTransparency = 0.15
    notifyLabel.TextTransparency       = 0

    -- After 'duration' seconds, fade everything out smoothly
    task.delay(duration, function()
        local fadeInfo = TweenInfo.new(0.8, Enum.EasingStyle.Linear)
        TweenService:Create(notifyFrame, fadeInfo, { BackgroundTransparency = 1 }):Play()
        TweenService:Create(notifyLabel, fadeInfo, { TextTransparency = 1 }):Play()
    end)
end


-- =============================================================
-- LISTEN: RoundUpdate
-- The server fires this for everyone when anything changes.
-- We get: state (string), message (string)
-- =============================================================
RoundUpdate.OnClientEvent:Connect(function(state, message)
    statusLabel.Text = message

    if state == "waiting" then
        setStatusColour(Color3.fromRGB(50, 50, 50))  -- Dark grey

    elseif state == "countdown" then
        setStatusColour(Color3.fromRGB(20, 80, 180))  -- Blue

    elseif state == "playing" then
        setStatusColour(Color3.fromRGB(20, 130, 40))  -- Green

    elseif state == "roundover" then
        setStatusColour(Color3.fromRGB(160, 110, 0))  -- Gold
        -- Also show a big popup for the win announcement
        showNotification(message, Color3.fromRGB(160, 110, 0), 5)
    end
end)


-- =============================================================
-- LISTEN: InfectNotify
-- Only fires for THIS local player when they just got infected.
-- =============================================================
InfectNotify.OnClientEvent:Connect(function()
    showNotification("YOU'RE INFECTED! Tag the others!", Color3.fromRGB(180, 0, 0), 3)
end)
