-- =============================================================
-- GameManager.server.lua
-- The "brain" of Tag, You're Toast.
--
-- ALL game decisions (who's the tagger, who's infected, who wins)
-- happen HERE on the server. Players can't cheat server-side code
-- because they never run it — it lives only on Roblox's machines.
-- The client script (GameUI) just listens and updates the screen.
-- =============================================================


-- =============================================================
-- TUNE THESE TO CHANGE HOW THE GAME FEELS
-- These are the first thing you should tweak when playtesting.
-- =============================================================
local CONFIG = {
    MIN_PLAYERS          = 2,   -- Players needed before a round starts
    COUNTDOWN_SECONDS    = 5,   -- "Round starting in X" countdown length
    ROUND_SECONDS        = 90,  -- How long each round lasts (in seconds)
    HUMAN_WALK_SPEED     = 16,  -- Normal Roblox walk speed is 16
    INFECTED_WALK_SPEED  = 18,  -- Infected move slightly faster so they can catch people
    RESET_DELAY          = 6,   -- Seconds to show the winner screen before resetting
}


-- =============================================================
-- SERVICES
-- These are Roblox's built-in systems. We grab references to
-- them once at the top so we can use them throughout the script.
-- =============================================================
local Players           = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")


-- =============================================================
-- REMOTE EVENTS
-- A RemoteEvent is how the server "shouts" at players' screens.
-- We put them in ReplicatedStorage so all scripts can find them.
-- =============================================================
local remoteFolder = Instance.new("Folder")
remoteFolder.Name  = "TagGameRemotes"
remoteFolder.Parent = ReplicatedStorage

-- Fires to ALL players when the round phase changes.
-- Carries: (stateString, messageString)
local RoundUpdate = Instance.new("RemoteEvent")
RoundUpdate.Name   = "RoundUpdate"
RoundUpdate.Parent = remoteFolder

-- Fires to ONE player when they personally just got infected.
local InfectNotify = Instance.new("RemoteEvent")
InfectNotify.Name   = "InfectNotify"
InfectNotify.Parent = remoteFolder


-- =============================================================
-- GAME STATE
-- Variables that track what's happening right now.
-- =============================================================

-- Which phase we're in. Possible values:
--   "waiting"   - not enough players yet
--   "countdown" - about to start
--   "playing"   - round in progress
--   "roundover" - showing winner, about to reset
local gameState = "waiting"

-- Maps each Player to their current role: "human" or "infected"
-- Example: playerRoles[alice] = "human", playerRoles[bob] = "infected"
local playerRoles = {}

-- Stores the .Touched connections we attach to infected players' bodies,
-- keyed by player. We keep them here so we can :Disconnect() them cleanly.
local touchConnections = {}

-- Debounce table: prevents one touch from firing infection 20 times at once.
-- The moment a player is tagged we mark them here for 0.5 seconds.
local tagDebounce = {}


-- =============================================================
-- HELPER: applyBodyColour
-- Changes a character's visible body parts to the given BrickColor.
-- Also updates the BodyColors object that controls avatar body tints.
-- =============================================================
local function applyBodyColour(character, colour)
    -- BodyColors controls the base tint of each limb
    local bodyColors = character:FindFirstChildOfClass("BodyColors")
    if bodyColors then
        bodyColors.HeadColor3     = colour.Color
        bodyColors.TorsoColor3    = colour.Color
        bodyColors.LeftArmColor3  = colour.Color
        bodyColors.RightArmColor3 = colour.Color
        bodyColors.LeftLegColor3  = colour.Color
        bodyColors.RightLegColor3 = colour.Color
    end

    -- Also set BrickColor on every BasePart to catch R15 characters
    -- and any accessories that poke through
    for _, part in ipairs(character:GetDescendants()) do
        if part:IsA("BasePart") and part.Name ~= "HumanoidRootPart" then
            part.BrickColor = colour
            part.Material   = Enum.Material.SmoothPlastic
        end
    end
end


-- =============================================================
-- HELPER: setRole
-- Assigns a role to a player and applies colour + speed.
-- Safe to call even if the character hasn't loaded yet —
-- CharacterAdded will re-call this when it does.
-- =============================================================
local function setRole(player, role)
    playerRoles[player] = role

    local character = player.Character
    if not character then return end

    local humanoid = character:FindFirstChildOfClass("Humanoid")
    if not humanoid then return end

    if role == "infected" then
        applyBodyColour(character, BrickColor.new("Bright red"))
        humanoid.WalkSpeed = CONFIG.INFECTED_WALK_SPEED
        InfectNotify:FireClient(player)  -- tell their screen "you're infected"
    else
        -- Human: plain grey so the red tagger stands out sharply
        applyBodyColour(character, BrickColor.new("Medium stone grey"))
        humanoid.WalkSpeed = CONFIG.HUMAN_WALK_SPEED
    end
end


-- =============================================================
-- TOUCH DETECTION — HOW WE AVOID THE CLASSIC TAG BUG
-- ---------------------------------------------------------
-- Problem: .Touched fires dozens of times per second while two
-- parts overlap. Without protection, one tag would try to infect
-- the same player 20+ times in one frame.
--
-- Our fix (two layers):
--   1. We attach .Touched to EVERY BasePart on the infected
--      character's body, not just HumanoidRootPart. This means
--      any brush of arm, leg, or torso counts as a tag, which
--      feels fair and responsive.
--   2. tagDebounce: the instant we register a hit we lock out
--      that victim for 0.5 seconds. Subsequent .Touched fires
--      during that window are silently dropped.
-- We also guard with gameState and playerRoles checks on the
-- server so the client can never fake a tag.
-- =============================================================

-- Forward-declare so attachTouchListeners can call infectPlayer
-- (they reference each other: infected players can infect others)
local infectPlayer

local function disconnectTouchListeners(player)
    if touchConnections[player] then
        for _, conn in ipairs(touchConnections[player]) do
            conn:Disconnect()
        end
        touchConnections[player] = nil
    end
end

local function attachTouchListeners(player)
    disconnectTouchListeners(player)  -- clear any old listeners first

    local character = player.Character
    if not character then return end

    local connections = {}

    for _, part in ipairs(character:GetDescendants()) do
        if part:IsA("BasePart") then
            local conn = part.Touched:Connect(function(otherPart)
                -- Guard: only act during live gameplay
                if gameState ~= "playing" then return end

                -- Work out which player owns the part we just touched
                local otherCharacter = otherPart.Parent
                local victim = Players:GetPlayerFromCharacter(otherCharacter)

                if not victim then return end          -- hit a wall/floor, not a player
                if victim == player then return end    -- infected touched their own body part
                if playerRoles[victim] ~= "human" then return end  -- already infected
                if tagDebounce[victim] then return end -- debounce: ignore repeat fires

                -- Lock this victim in the debounce immediately
                tagDebounce[victim] = true
                infectPlayer(victim)

                -- Release the debounce after half a second
                task.delay(0.5, function()
                    tagDebounce[victim] = nil
                end)
            end)
            table.insert(connections, conn)
        end
    end

    touchConnections[player] = connections
end

-- infectPlayer: switches a player from human -> infected
infectPlayer = function(player)
    setRole(player, "infected")
    attachTouchListeners(player)  -- they can now spread the infection
    print("[TagGame] " .. player.Name .. " is now INFECTED")
end


-- =============================================================
-- WIN CONDITION CHECK
-- Returns true when the round should end (0 or 1 human left).
-- =============================================================
local function isRoundOver()
    local humanCount = 0
    for player, role in pairs(playerRoles) do
        -- Only count players still in the server
        if Players:FindFirstChild(player.Name) and role == "human" then
            humanCount += 1
        end
    end
    return humanCount <= 1
end

-- Returns a list of players who are still human and in the game
local function getLivingHumans()
    local humans = {}
    for player, role in pairs(playerRoles) do
        if Players:FindFirstChild(player.Name) and role == "human" then
            table.insert(humans, player)
        end
    end
    return humans
end


-- =============================================================
-- BROADCAST
-- Sends a state + message to every player's UI at once.
-- =============================================================
local function broadcast(state, message)
    RoundUpdate:FireAllClients(state, message)
end


-- =============================================================
-- CLEANUP
-- Disconnects all touch listeners and resets all tracking tables.
-- Called at the very start of each round to wipe the old state.
-- =============================================================
local function cleanupRound()
    for player in pairs(touchConnections) do
        disconnectTouchListeners(player)
    end
    playerRoles    = {}
    tagDebounce    = {}

    -- Reset all characters back to grey
    for _, player in ipairs(Players:GetPlayers()) do
        if player.Character then
            applyBodyColour(player.Character, BrickColor.new("Medium stone grey"))
            local hum = player.Character:FindFirstChildOfClass("Humanoid")
            if hum then hum.WalkSpeed = CONFIG.HUMAN_WALK_SPEED end
        end
    end
end


-- =============================================================
-- EDGE CASE: Player leaves mid-round
-- When someone leaves, wipe their entry from every table.
-- The isRoundOver() loop only counts players still in-game,
-- so the round automatically adjusts without us doing anything else.
-- =============================================================
Players.PlayerRemoving:Connect(function(player)
    disconnectTouchListeners(player)
    playerRoles[player] = nil
    tagDebounce[player] = nil
    print("[TagGame] " .. player.Name .. " left the game")
end)


-- =============================================================
-- EDGE CASE: Character respawns or joins mid-round
-- If a player resets (fell off the map, used the Reset button),
-- their new character has no colour or speed applied.
-- CharacterAdded fires every time a character loads, so we
-- re-apply their current role to fix the blank appearance.
--
-- Also handles players who JOIN in the middle of a round —
-- they get role "human" so they can be infected normally.
-- =============================================================
local function setupPlayerListeners(player)
    player.CharacterAdded:Connect(function(character)
        -- Wait one frame so all character children exist before we touch them
        task.wait()

        local existingRole = playerRoles[player]

        if existingRole then
            -- Player was already in a round — restore their role
            setRole(player, existingRole)
            if existingRole == "infected" then
                attachTouchListeners(player)
            end
        elseif gameState == "playing" then
            -- New joiner mid-round: start as human, can be infected
            setRole(player, "human")
        end
    end)
end

-- Wire up the listener for any player who joins from now on
Players.PlayerAdded:Connect(setupPlayerListeners)

-- Wire up listeners for anyone already in the game when the script loads
-- (this matters in Studio when you press Play and all test players connect at once)
for _, player in ipairs(Players:GetPlayers()) do
    setupPlayerListeners(player)
end


-- =============================================================
-- MAIN GAME LOOP
-- Cycles forever: waiting -> countdown -> playing -> round over -> repeat
-- =============================================================
local function runGame()
    while true do

        -- -------------------------------------------------------
        -- PHASE: WAITING
        -- Sit here until enough players are in the server.
        -- -------------------------------------------------------
        gameState = "waiting"
        cleanupRound()

        while #Players:GetPlayers() < CONFIG.MIN_PLAYERS do
            broadcast(
                "waiting",
                "Waiting for players... (" .. #Players:GetPlayers() .. "/" .. CONFIG.MIN_PLAYERS .. " needed)"
            )
            task.wait(1)
        end


        -- -------------------------------------------------------
        -- PHASE: COUNTDOWN
        -- Count down from COUNTDOWN_SECONDS. If a player leaves
        -- mid-countdown and we drop below the minimum, cancel.
        -- -------------------------------------------------------
        gameState = "countdown"
        local cancelled = false

        for i = CONFIG.COUNTDOWN_SECONDS, 1, -1 do
            if #Players:GetPlayers() < CONFIG.MIN_PLAYERS then
                cancelled = true
                break
            end
            broadcast("countdown", "Round starting in " .. i .. "!")
            task.wait(1)
        end

        if cancelled then
            broadcast("waiting", "Not enough players — round cancelled!")
            task.wait(2)
            continue  -- Jump back to the top of the while loop (waiting phase)
        end


        -- -------------------------------------------------------
        -- PHASE: PLAYING — SETUP
        -- Assign every current player a role, then pick one tagger.
        -- -------------------------------------------------------
        gameState = "playing"

        local allPlayers = Players:GetPlayers()

        -- Everyone starts as a human
        for _, player in ipairs(allPlayers) do
            setRole(player, "human")
        end

        -- Pick one random tagger from all current players
        local taggerIndex = math.random(1, #allPlayers)
        local tagger      = allPlayers[taggerIndex]

        infectPlayer(tagger)

        broadcast("playing", tagger.Name .. " is the TAGGER! RUN!")
        task.wait(2)  -- Brief pause so players can read who the tagger is


        -- -------------------------------------------------------
        -- PHASE: PLAYING — ROUND LOOP
        -- Count down the round timer. Exit early if the win
        -- condition is met (only 0 or 1 humans remain).
        -- -------------------------------------------------------
        local timeLeft = CONFIG.ROUND_SECONDS

        while timeLeft > 0 do
            if isRoundOver() then
                break  -- Someone won before the timer ran out
            end

            -- Show time remaining in the status bar
            broadcast("playing", "Time left: " .. timeLeft .. "s")
            task.wait(1)
            timeLeft -= 1
        end


        -- -------------------------------------------------------
        -- PHASE: ROUND OVER
        -- Figure out who won and tell everyone.
        -- -------------------------------------------------------
        gameState = "roundover"

        local survivors = getLivingHumans()
        local winMessage

        if #survivors == 0 then
            winMessage = "Everyone got infected! No survivors!"
        elseif #survivors == 1 then
            winMessage = survivors[1].Name .. " is the LAST SURVIVOR!"
        else
            -- Timer expired with multiple humans still alive
            local names = {}
            for _, p in ipairs(survivors) do
                table.insert(names, p.Name)
            end
            winMessage = "Time's up! Survivors: " .. table.concat(names, ", ")
        end

        broadcast("roundover", winMessage)
        print("[TagGame] Round over: " .. winMessage)

        -- Hold the result screen for a few seconds before resetting
        task.wait(CONFIG.RESET_DELAY)

        -- Loop back up to the waiting phase to start a new round
    end
end

-- Start the game
runGame()
