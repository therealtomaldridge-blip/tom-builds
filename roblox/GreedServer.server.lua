-- =============================================================================
--  GREED — Roblox SERVER script
-- -----------------------------------------------------------------------------
--  WHERE THIS GOES:  ServerScriptService  (as a regular "Script")
--
--  Roblox gives you players, movement, jumping, camera and mobile controls for
--  free, so this script just builds the world and runs the game:
--    - procedurally builds a vault tower of platforms + loot each round
--    - rising lava that gets faster each round; touching it (or falling below
--      it) kills you and you drop your haul
--    - grab loot by touching it; the more you carry the slower you move (greed)
--    - bank your haul on the gold EXIT pad at the top to score
--    - shove nearby players (client sends a Shove event) to make them drop loot
--
--  Pair it with GreedClient (a LocalScript in StarterPlayerScripts).
-- =============================================================================

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

-- ------------------------------------------------------------------ config ---
local CFG = {
	ARENA_R = 28,        -- half-width of the tower footprint (studs)
	LEVELS = 12,
	GAP_Y = 14,          -- vertical gap between platform levels
	ROUND_TIME = 75,     -- seconds per round
	INTERMISSION = 6,
	BASE_LAVA_SPEED = 5, -- studs/sec, + per round
	MAX_ROUNDS = 3,
}

-- shared state -----------------------------------------------------------------
local bagValue: {[Player]: number} = {}   -- $ currently carried
local bagCount: {[Player]: number} = {}   -- item count (drives weight)
local worldFolder: Folder? = nil
local exitPad: BasePart? = nil
local lavaPart: BasePart? = nil
local lavaY = -50
local roundActive = false

-- Shove RemoteEvent (created here, used by the client) -------------------------
local shoveEvent = Instance.new("RemoteEvent")
shoveEvent.Name = "Shove"
shoveEvent.Parent = ReplicatedStorage

-- ------------------------------------------------------------- leaderstats ---
local function setupPlayer(plr: Player)
	bagValue[plr] = 0
	bagCount[plr] = 0

	local stats = Instance.new("Folder")
	stats.Name = "leaderstats"
	local bag = Instance.new("IntValue"); bag.Name = "Bag"; bag.Parent = stats
	local banked = Instance.new("IntValue"); banked.Name = "Banked"; banked.Parent = stats
	stats.Parent = plr
end

local function getStat(plr: Player, name: string): IntValue?
	local stats = plr:FindFirstChild("leaderstats")
	return stats and stats:FindFirstChild(name) :: IntValue or nil
end

local function updateWeight(plr: Player)
	local char = plr.Character
	if not char then return end
	local hum = char:FindFirstChildOfClass("Humanoid")
	if not hum then return end
	local c = bagCount[plr] or 0
	hum.WalkSpeed = math.max(7, 16 - c * 0.55)
	hum.UseJumpPower = true
	hum.JumpPower = math.max(28, 50 - c * 1.4)
	local bag = getStat(plr, "Bag")
	if bag then bag.Value = bagValue[plr] or 0 end
end

local function resetBag(plr: Player)
	bagValue[plr] = 0
	bagCount[plr] = 0
	updateWeight(plr)
end

-- --------------------------------------------------------------- helpers -----
local function newPart(size: Vector3, pos: Vector3, color: Color3, material: Enum.Material, parent: Instance): BasePart
	local p = Instance.new("Part")
	p.Anchored = true
	p.Size = size
	p.Position = pos
	p.Color = color
	p.Material = material
	p.TopSurface = Enum.SurfaceType.Smooth
	p.BottomSurface = Enum.SurfaceType.Smooth
	p.Parent = parent
	return p
end

local function dropBag(plr: Player, pos: Vector3)
	local value = bagValue[plr] or 0
	if value <= 0 or not worldFolder then resetBag(plr); return end
	resetBag(plr)
	-- a stealable money bag worth what they were carrying
	local bag = newPart(Vector3.new(2, 2, 2), pos + Vector3.new(0, 2, 0),
		Color3.fromRGB(255, 200, 60), Enum.Material.Neon, worldFolder)
	bag.Shape = Enum.PartType.Ball
	bag:SetAttribute("Value", value)
	bag.Name = "DroppedBag"
	local taken = false
	bag.Touched:Connect(function(hit)
		if taken then return end
		local other = Players:GetPlayerFromCharacter(hit.Parent)
		if not other then return end
		taken = true
		bagValue[other] = (bagValue[other] or 0) + value
		bagCount[other] = (bagCount[other] or 0) + 1
		updateWeight(other)
		bag:Destroy()
	end)
end

-- --------------------------------------------------------------- world -------
local SpawnPad: SpawnLocation

local function ensureSpawn()
	if SpawnPad and SpawnPad.Parent then return end
	SpawnPad = Instance.new("SpawnLocation")
	SpawnPad.Name = "GreedSpawn"
	SpawnPad.Anchored = true
	SpawnPad.Size = Vector3.new(CFG.ARENA_R * 2, 1, CFG.ARENA_R * 2)
	SpawnPad.Position = Vector3.new(0, 0, 0)
	SpawnPad.Color = Color3.fromRGB(40, 36, 64)
	SpawnPad.Material = Enum.Material.SmoothPlastic
	SpawnPad.Neutral = true
	SpawnPad.Duration = 0
	SpawnPad.Parent = workspace
end

local function clearWorld()
	if worldFolder then worldFolder:Destroy() end
	worldFolder = nil
	exitPad = nil
	lavaPart = nil
end

local function makeLoot(kind: string, pos: Vector3)
	local color, value, size, shape
	if kind == "coin" then
		color, value = Color3.fromRGB(255, 209, 102), 1
		size, shape = Vector3.new(2, 0.4, 2), Enum.PartType.Cylinder
	elseif kind == "gem" then
		color, value = Color3.fromRGB(76, 201, 240), 3
		size, shape = Vector3.new(2, 2, 2), Enum.PartType.Ball
	else
		color, value = Color3.fromRGB(255, 170, 0), 10
		size, shape = Vector3.new(3, 2.4, 2.4), Enum.PartType.Block
	end
	local p = newPart(size, pos, color, Enum.Material.Neon, worldFolder :: Instance)
	p.Shape = shape
	if shape == Enum.PartType.Cylinder then p.Orientation = Vector3.new(0, 0, 90) end
	p.CanCollide = false
	p.Name = "Loot"

	local taken = false
	p.Touched:Connect(function(hit)
		if taken or not roundActive then return end
		local plr = Players:GetPlayerFromCharacter(hit.Parent)
		if not plr then return end
		taken = true
		bagValue[plr] = (bagValue[plr] or 0) + value
		bagCount[plr] = (bagCount[plr] or 0) + 1
		updateWeight(plr)
		p:Destroy()
	end)
end

local function buildWorld(roundNum: number)
	clearWorld()
	worldFolder = Instance.new("Folder")
	worldFolder.Name = "GreedWorld"
	worldFolder.Parent = workspace

	-- ground
	newPart(Vector3.new(CFG.ARENA_R * 2, 2, CFG.ARENA_R * 2), Vector3.new(0, -1, 0),
		Color3.fromRGB(40, 36, 64), Enum.Material.SmoothPlastic, worldFolder)

	local kinds = { "coin", "coin", "coin", "gem", "gem", "treasure" }
	local levels = CFG.LEVELS + roundNum
	for i = 1, levels do
		local y = i * CFG.GAP_Y
		local n = 1 + math.random(0, 1)
		for _ = 1, n do
			local sx = 10 + math.random() * 6
			local sz = 10 + math.random() * 6
			local x = (math.random() * 2 - 1) * (CFG.ARENA_R - sx / 2 - 2)
			local z = (math.random() * 2 - 1) * (CFG.ARENA_R - sz / 2 - 2)
			newPart(Vector3.new(sx, 1.5, sz), Vector3.new(x, y, z),
				Color3.fromRGB(74, 63, 107), Enum.Material.SmoothPlastic, worldFolder)
			for _ = 1, 1 + math.random(0, 1) do
				local lp = Vector3.new(
					x + (math.random() * 2 - 1) * (sx / 2 - 2),
					y + 2.2,
					z + (math.random() * 2 - 1) * (sz / 2 - 2))
				makeLoot(kinds[math.random(1, #kinds)], lp)
			end
		end
	end

	-- exit pad (gold) at the top
	local exitY = (levels + 1) * CFG.GAP_Y
	exitPad = newPart(Vector3.new(14, 1.5, 14), Vector3.new(0, exitY, 0),
		Color3.fromRGB(255, 209, 102), Enum.Material.Neon, worldFolder)
	exitPad.Name = "ExitPad"
	exitPad.Touched:Connect(function(hit)
		if not roundActive then return end
		local plr = Players:GetPlayerFromCharacter(hit.Parent)
		if not plr then return end
		local v = bagValue[plr] or 0
		if v <= 0 then return end
		local banked = getStat(plr, "Banked")
		if banked then banked.Value += v end
		resetBag(plr)
	end)

	-- lava
	lavaPart = newPart(Vector3.new(CFG.ARENA_R * 6, 4, CFG.ARENA_R * 6), Vector3.new(0, -50, 0),
		Color3.fromRGB(255, 70, 30), Enum.Material.Neon, worldFolder)
	lavaPart.Name = "Lava"
	lavaPart.CanCollide = false
	lavaPart.Touched:Connect(function(hit)
		if not roundActive then return end
		local char = hit.Parent
		local hum = char and char:FindFirstChildOfClass("Humanoid")
		if hum and hum.Health > 0 then
			local plr = Players:GetPlayerFromCharacter(char)
			local hrp = char:FindFirstChild("HumanoidRootPart") :: BasePart?
			if plr and hrp then dropBag(plr, hrp.Position) end
			hum.Health = 0
		end
	end)

	return exitY
end

-- ------------------------------------------------------- teleport / reset ----
local function teleportToBase(plr: Player)
	local char = plr.Character
	if not char then return end
	local hrp = char:FindFirstChild("HumanoidRootPart") :: BasePart?
	if hrp then
		local ang = math.random() * math.pi * 2
		hrp.CFrame = CFrame.new(math.cos(ang) * 6, 4, math.sin(ang) * 6)
	end
	resetBag(plr)
end

-- ------------------------------------------------------------- shove ---------
shoveEvent.OnServerEvent:Connect(function(plr)
	if not roundActive then return end
	local char = plr.Character
	local hrp = char and char:FindFirstChild("HumanoidRootPart") :: BasePart?
	if not hrp then return end
	local from = hrp.Position
	local look = hrp.CFrame.LookVector

	for _, other in Players:GetPlayers() do
		if other == plr then continue end
		local oc = other.Character
		local ohrp = oc and oc:FindFirstChild("HumanoidRootPart") :: BasePart?
		if not ohrp then continue end
		local to = ohrp.Position - from
		local dist = to.Magnitude
		if dist > 9 then continue end
		local dir = to.Unit
		if dir:Dot(look) < 0.4 then continue end -- must be roughly in front
		-- knockback + drop their loot
		dropBag(other, ohrp.Position)
		ohrp.AssemblyLinearVelocity = (dir * 55) + Vector3.new(0, 30, 0)
	end
end)

-- -------------------------------------------------------- round game loop ----
local function setHud(state: string, round: number, timeLeft: number)
	workspace:SetAttribute("GreedState", state)
	workspace:SetAttribute("GreedRound", round)
	workspace:SetAttribute("GreedTime", math.max(0, math.floor(timeLeft + 0.5)))
	workspace:SetAttribute("GreedMaxRounds", CFG.MAX_ROUNDS)
end

local function gameLoop()
	ensureSpawn()
	local roundNum = 0
	while true do
		roundNum = (roundNum % CFG.MAX_ROUNDS) + 1
		local exitY = buildWorld(roundNum)
		lavaY = -45
		if lavaPart then lavaPart.Position = Vector3.new(0, lavaY, 0) end

		-- bring everyone to the base
		for _, plr in Players:GetPlayers() do teleportToBase(plr) end

		roundActive = true
		local lavaSpeed = CFG.BASE_LAVA_SPEED + roundNum * 2.5
		local t = CFG.ROUND_TIME
		while t > 0 do
			local dt = task.wait(0.1)
			t -= dt
			lavaY += lavaSpeed * dt
			if lavaPart then lavaPart.Position = Vector3.new(0, lavaY, 0) end
			-- catch anyone who fell below the lava line
			for _, plr in Players:GetPlayers() do
				local char = plr.Character
				local hrp = char and char:FindFirstChild("HumanoidRootPart") :: BasePart?
				local hum = char and char:FindFirstChildOfClass("Humanoid")
				if hrp and hum and hum.Health > 0 and hrp.Position.Y < lavaY then
					dropBag(plr, hrp.Position)
					hum.Health = 0
				end
			end
			setHud("Playing", roundNum, t)
			if lavaY > exitY + 6 then break end -- lava swallowed the whole tower
		end

		roundActive = false
		setHud("Intermission", roundNum, 0)
		for _, plr in Players:GetPlayers() do resetBag(plr) end
		task.wait(CFG.INTERMISSION)
	end
end

-- ------------------------------------------------------------- wiring --------
Players.PlayerAdded:Connect(function(plr)
	setupPlayer(plr)
	plr.CharacterAdded:Connect(function()
		task.wait(0.2)
		updateWeight(plr)
	end)
end)
Players.PlayerRemoving:Connect(function(plr)
	bagValue[plr] = nil
	bagCount[plr] = nil
end)
for _, plr in Players:GetPlayers() do setupPlayer(plr) end

task.spawn(gameLoop)
print("[GREED] server started")
