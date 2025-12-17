import { createClient } from '@supabase/supabase-js'
import { REST } from '@discordjs/rest'
import { WebSocketManager, WebSocketShardEvents } from '@discordjs/ws'
import { Routes, GatewayIntentBits, GatewayDispatchEvents } from 'discord-api-types/v10'
import type { APIGuildMember } from 'discord-api-types/v10'

// Configuration
const supabaseUrl = Deno.env.get("SUPABASE_URL")
const supabaseKey = Deno.env.get("SUPABASE_KEY")
const guildIds = Deno.env.get("GUILD_SNOWFLAKES")?.split(",").map(s => s.trim()).filter(Boolean) ?? []
const discordToken = Deno.env.get("DISCORD_TOKEN")

const TABLE_NAME = 'user_roles'
const PAGE_LIMIT = 1000

if (!discordToken || !supabaseUrl || !supabaseKey) {
  throw new Error('Missing required env variables: SUPABASE_URL, SUPABASE_KEY, DISCORD_TOKEN')
}

if (guildIds.length === 0) {
  throw new Error('Missing GUILD_SNOWFLAKES env variable (comma-separated guild IDs)')
}

// Types
interface UserRoleRow {
  guild_snowflake: string
  discord_id: string
  discord_role: string[]
}

// Composite key for the in-memory cache: "guild_id:discord_id"
function cacheKey(guildId: string, discordId: string): string {
  return `${guildId}:${discordId}`
}

// Clients
const supabase = createClient(supabaseUrl, supabaseKey)
const rest = new REST({ version: '10' }).setToken(discordToken)

// In-memory cache: Map<"guild:user", roles[]>
const rolesCache = await fetchAllSupabaseRoles()

const manager = new WebSocketManager({
  token: discordToken,
  intents: GatewayIntentBits.GuildMembers,
  shardCount: 1,
  rest,
})

manager.on(WebSocketShardEvents.Dispatch, async (event) => {
  switch (event.t) {
    case GatewayDispatchEvents.Ready:
      console.log(`Starting sync for ${guildIds.length} guild(s)...`)
      await initialSync()
      console.log("Sync complete! Exiting.")
      Deno.exit(0) //Added for Batch Sync
      break

    case GatewayDispatchEvents.GuildMemberUpdate: {
      const { guild_id, user, roles } = event.d
      if (guildIds.includes(guild_id)) {
        await syncUserRoles(guild_id, user.id, roles)
      }
      break
    }

    case GatewayDispatchEvents.GuildMemberRemove: {
      const { guild_id, user } = event.d
      if (guildIds.includes(guild_id)) {
        await removeUserRoles(guild_id, user.id)
      }
      break
    }
  }
})

manager.on(WebSocketShardEvents.Error, (error) => {
  console.error("WebSocket error:", error)
  throw error
})

await manager.connect()

// Database functions

async function fetchAllSupabaseRoles(): Promise<Map<string, string[]>> {
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select("guild_snowflake, discord_id, discord_role")
    .in('guild_snowflake', guildIds)

  if (error) throw error

  const cache = new Map<string, string[]>()
  for (const row of data as UserRoleRow[]) {
    if (row.guild_snowflake && row.discord_id) {
      cache.set(cacheKey(row.guild_snowflake, row.discord_id), row.discord_role ?? [])
    }
  }
  return cache
}

function fetchGuildMembersPage(guildId: string, after?: string): Promise<APIGuildMember[]> {
  const query = new URLSearchParams({ limit: String(PAGE_LIMIT) })
  if (after) {
    query.set('after', after)
  }
  return rest.get(Routes.guildMembers(guildId), { query }) as Promise<APIGuildMember[]>
}

async function initialSync(): Promise<void> {
  for (const guildId of guildIds) {
    console.log(`Syncing guild: ${guildId}`)

    // Fetch all members from Discord
    const guildMembers: APIGuildMember[] = []
    let page = await fetchGuildMembersPage(guildId)
    guildMembers.push(...page)

    while (page.length === PAGE_LIMIT) {
      const lastMember = guildMembers[guildMembers.length - 1]
      page = await fetchGuildMembersPage(guildId, lastMember.user?.id)
      guildMembers.push(...page)
    }

    console.log(`Found ${guildMembers.length} members in guild ${guildId}`)

    // Sync all members' roles
    const syncResults = await Promise.allSettled(
      guildMembers
        .filter(member => member.user?.id)
        .map(member => syncUserRoles(guildId, member.user!.id, member.roles))
    )

    const failures = syncResults.filter(r => r.status === 'rejected')
    if (failures.length > 0) {
      console.error(`Failed to sync ${failures.length} members in guild ${guildId}`)
    }

    // Remove users no longer in the Discord guild
    const discordUserIds = new Set(guildMembers.map(m => m.user?.id).filter(Boolean))
    const cachedKeys = [...rolesCache.keys()].filter(key => key.startsWith(`${guildId}:`))

    for (const key of cachedKeys) {
      const discordId = key.split(':')[1]
      if (!discordUserIds.has(discordId)) {
        await removeUserRoles(guildId, discordId)
      }
    }
  }
}

async function upsertUserRoles(guildId: string, discordId: string, roles: string[]): Promise<void> {
  const { error } = await supabase
    .from(TABLE_NAME)
    .upsert(
      { guild_snowflake: guildId, discord_id: discordId, discord_role: roles },
      { onConflict: 'guild_snowflake,discord_id' }
    )

  if (error) {
    console.error(`Failed to upsert roles for ${discordId} in guild ${guildId}:`, error.message)
    return
  }

  rolesCache.set(cacheKey(guildId, discordId), roles)
}

async function removeUserRoles(guildId: string, discordId: string): Promise<void> {
  const { error } = await supabase
    .from(TABLE_NAME)
    .delete()
    .eq('guild_snowflake', guildId)
    .eq('discord_id', discordId)

  if (error) {
    console.error(`Failed to remove roles for ${discordId} in guild ${guildId}:`, error.message)
    return
  }

  rolesCache.delete(cacheKey(guildId, discordId))
  console.log(`Removed ${discordId} from guild ${guildId}`)
}

async function syncUserRoles(guildId: string, discordId: string, roles: string[]): Promise<void> {
  const key = cacheKey(guildId, discordId)
  const existing = rolesCache.get(key)

  if (existing) {
    const cachedRoles = new Set(existing)
    const discordRoles = new Set(roles)

    // Only update if roles changed
    if (cachedRoles.symmetricDifference(discordRoles).size === 0) {
      return
    }
  }

  await upsertUserRoles(guildId, discordId, roles)
}
