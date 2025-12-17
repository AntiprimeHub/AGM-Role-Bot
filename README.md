# Discord Role Sync Bot

A lightweight Deno-based Discord bot that synchronizes member roles from Discord servers to a Supabase database. Supports multiple Discord servers (guilds) simultaneously.

## Features

- Syncs Discord member roles to Supabase in real-time
- Multi-server support via comma-separated guild IDs
- Batch sync on startup with automatic cleanup of departed members
- In-memory caching for efficient change detection
- Graceful error handling with partial failure resilience

## Prerequisites

- [Deno](https://deno.land/) v2.0+
- [Supabase](https://supabase.com/) project
- Discord Bot Token with Server Members Intent enabled

## Database Setup

Create the `user_roles` table in your Supabase project:

```sql
CREATE TABLE public.user_roles (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID NULL,
  discord_id TEXT NULL,
  discord_role TEXT[] NULL,
  guild_snowflake TEXT NULL,
  CONSTRAINT user_roles_pkey PRIMARY KEY (id),
  CONSTRAINT user_roles_guild_discord_key UNIQUE (guild_snowflake, discord_id),
  CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users (id) ON UPDATE CASCADE ON DELETE CASCADE
);
```

The composite unique constraint on `(guild_snowflake, discord_id)` allows the same Discord user to exist in multiple servers.

## Discord Bot Setup

1. Create a new application at [Discord Developer Portal](https://discord.com/developers/applications)
2. Go to **Bot** section and create a bot
3. Enable **Server Members Intent** under Privileged Gateway Intents
4. Copy the bot token for your `.env` file
5. Invite the bot to your server(s) using this URL format:
   ```
   https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=0&scope=bot
   ```

### Required Permissions

| Type | Permission |
|------|------------|
| Gateway Intent | Server Members Intent (Privileged) |
| OAuth2 Scope | `bot` |
| Bot Permissions | None (read-only) |

## Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd <repository-name>
   ```

2. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

3. Configure your `.env` file:
   ```env
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_KEY=your_service_role_key_here
   GUILD_SNOWFLAKES=123456789,987654321
   DISCORD_TOKEN=your_bot_token_here
   ```

4. Install dependencies:
   ```bash
   deno install
   ```

## Usage

### Development

Run with file watching:

```bash
deno task dev
```

Or manually:

```bash
deno run --allow-all --env roles.ts
```

### Production

#### Direct execution

```bash
deno run --allow-all --env roles.ts
```

#### Docker

Build the image:

```bash
docker build -t discord-role-sync .
```

Run the container:

```bash
docker run --env-file .env discord-role-sync
```

## Configuration

| Environment Variable | Description | Example |
|---------------------|-------------|---------|
| `SUPABASE_URL` | Your Supabase project URL | `https://abc123.supabase.co` |
| `SUPABASE_KEY` | Supabase service role key | `eyJhbGc...` |
| `GUILD_SNOWFLAKES` | Comma-separated Discord server IDs | `123456789,987654321` |
| `DISCORD_TOKEN` | Discord bot token | `MTIz...` |

## How It Works

1. **Startup**: Connects to Discord via WebSocket and loads existing role data from Supabase into memory
2. **Initial Sync**: Fetches all members from configured guilds and syncs their roles to the database
3. **Cleanup**: Removes database entries for users no longer in the Discord server
4. **Exit**: By default, exits after initial sync (batch mode)

### Real-time Mode

To run continuously and listen for role changes, remove or comment out the `Deno.exit(0)` line in `roles.ts`:

```typescript
case GatewayDispatchEvents.Ready:
  console.log(`Starting sync for ${guildIds.length} guild(s)...`)
  await initialSync()
  console.log("Sync complete!")
  // Deno.exit(0) // Comment this out for continuous operation
  break
```

## Database Schema

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `user_id` | UUID | Optional FK to Supabase auth.users |
| `discord_id` | TEXT | Discord user snowflake |
| `discord_role` | TEXT[] | Array of Discord role snowflakes |
| `guild_snowflake` | TEXT | Discord server snowflake |

## License

MIT
