-- =============================================================================
--  GREED — Roblox CLIENT script
-- -----------------------------------------------------------------------------
--  WHERE THIS GOES:  StarterPlayer > StarterPlayerScripts  (as a "LocalScript")
--
--  Roblox already gives the player movement, jumping, camera and touch controls.
--  This just adds:
--    - a small HUD (round + countdown + your current bag), and
--    - the SHOVE action (press F on PC, or tap the on-screen SHOVE button on
--      mobile) which tells the server to shove whoever is in front of you.
-- =============================================================================

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local UserInputService = game:GetService("UserInputService")
local ContextActionService = game:GetService("ContextActionService")
local RunService = game:GetService("RunService")

local player = Players.LocalPlayer
local shove = ReplicatedStorage:WaitForChild("Shove")

-- ------------------------------------------------------------------- HUD -----
local gui = Instance.new("ScreenGui")
gui.Name = "GreedHUD"
gui.ResetOnSpawn = false
gui.IgnoreGuiInset = true
gui.Parent = player:WaitForChild("PlayerGui")

local function label(size: UDim2, pos: UDim2, txt: string, color: Color3, scale: number)
	local l = Instance.new("TextLabel")
	l.Size = size; l.Position = pos
	l.BackgroundColor3 = Color3.fromRGB(15, 12, 26)
	l.BackgroundTransparency = 0.25
	l.TextColor3 = color
	l.Font = Enum.Font.GothamBold
	l.TextScaled = false
	l.TextSize = 22 * scale
	l.Text = txt
	l.BorderSizePixel = 0
	local corner = Instance.new("UICorner"); corner.CornerRadius = UDim.new(0, 10); corner.Parent = l
	l.Parent = gui
	return l
end

local roundLbl = label(UDim2.new(0, 150, 0, 40), UDim2.new(0.5, -250, 0, 12), "Round 1/3", Color3.fromRGB(163, 230, 53), 1)
local timeLbl  = label(UDim2.new(0, 110, 0, 40), UDim2.new(0.5, -55, 0, 12), "75", Color3.fromRGB(76, 201, 240), 1)
local bagLbl   = label(UDim2.new(0, 150, 0, 40), UDim2.new(0.5, 100, 0, 12), "Bag $0", Color3.fromRGB(255, 209, 102), 1)
local hintLbl  = label(UDim2.new(0, 520, 0, 34), UDim2.new(0.5, -260, 1, -120), "Grab loot - bank it on the gold EXIT at the top!", Color3.fromRGB(220, 215, 235), 0.85)
hintLbl.TextSize = 18

-- ----------------------------------------------------------- HUD updates -----
local function refreshHud()
	local state = workspace:GetAttribute("GreedState") or "Playing"
	local round = workspace:GetAttribute("GreedRound") or 1
	local maxR = workspace:GetAttribute("GreedMaxRounds") or 3
	local timeLeft = workspace:GetAttribute("GreedTime") or 0
	roundLbl.Text = "Round " .. round .. "/" .. maxR

	if state == "Intermission" then
		timeLbl.Text = "..."
		timeLbl.TextColor3 = Color3.fromRGB(160, 150, 180)
		hintLbl.Text = "Next round starting..."
	else
		timeLbl.Text = tostring(timeLeft)
		timeLbl.TextColor3 = timeLeft <= 10 and Color3.fromRGB(255, 90, 95) or Color3.fromRGB(76, 201, 240)
		hintLbl.Text = "Grab loot - SHOVE rivals (F) - bank on the gold EXIT up top!"
	end

	-- bag from leaderstats
	local stats = player:FindFirstChild("leaderstats")
	local bag = stats and stats:FindFirstChild("Bag")
	bagLbl.Text = "Bag $" .. (bag and bag.Value or 0)
end

RunService.RenderStepped:Connect(refreshHud)

-- -------------------------------------------------------------- shove --------
local function doShove(_, inputState: Enum.UserInputState)
	if inputState == Enum.UserInputState.Begin then
		shove:FireServer()
	end
	return Enum.ContextActionResult.Pass
end

-- F on keyboard + an on-screen button on touch devices
ContextActionService:BindAction("GreedShove", doShove, true, Enum.KeyCode.F)
ContextActionService:SetTitle("GreedShove", "SHOVE")
ContextActionService:SetPosition("GreedShove", UDim2.new(1, -120, 1, -160))

print("[GREED] client ready - press F to shove")
