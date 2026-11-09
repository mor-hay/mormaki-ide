local M = {}

local function find_repo_root()
  local ok, packs = pcall(maki.pack.get, { "mormaki-ide" })
  if ok and type(packs) == "table" and packs[1] and packs[1].path then
    return packs[1].path
  end
  local home = maki.uv.os_homedir() or ""
  local fallback = maki.fs.joinpath(home, "maki-ide")
  if maki.fs.metadata(fallback) then
    return fallback
  end
  return nil
end

function M.launch(target_dir)
  local workspace = target_dir
  if not workspace or workspace == "" then
    workspace = maki.uv.cwd()
  else
    workspace = maki.fs.abspath(workspace)
  end

  local root = find_repo_root()
  if not root then
    maki.notify("MorMaki IDE: package directory not found", "error")
    return false, "MorMaki IDE directory not found"
  end

  local release_bin = maki.fs.joinpath(root, "src-tauri", "target", "release", "maki-ide")
  local debug_bin = maki.fs.joinpath(root, "src-tauri", "target", "debug", "maki-ide")

  local cmd
  if maki.fs.metadata(release_bin) then
    cmd = { release_bin, workspace }
  elseif maki.fs.metadata(debug_bin) then
    cmd = { debug_bin, workspace }
  else
    cmd = "source ~/.cargo/env 2>/dev/null; npm run tauri dev"
  end

  local job_id, err = maki.fn.jobstart(cmd, {
    cwd = root,
    env = { MORMAKI_WORKSPACE = workspace },
    scope = "plugin",
    stdout = false,
    stderr = false,
  })

  if not job_id then
    maki.notify("Failed to launch MorMaki IDE: " .. tostring(err), "error")
    return false, err
  end

  maki.ui.flash("Launched MorMaki IDE (" .. workspace .. ")")
  return true, workspace
end

function M.setup()
  maki.api.register_command({
    name = "/ide",
    nargs = "?",
    description = "Open MorMaki IDE desktop app in the current (or given) workspace",
    handler = function(opts)
      M.launch(opts and opts.args or nil)
    end,
  })

  maki.api.register_command({
    name = "/mormaki",
    nargs = "?",
    description = "Open MorMaki IDE desktop app in the current (or given) workspace",
    handler = function(opts)
      M.launch(opts and opts.args or nil)
    end,
  })

  maki.api.register_tool({
    name = "open_mormaki_ide",
    permission = "run",
    description = "Launch the MorMaki IDE desktop graphical editor (Cursor-like UI with Monaco editor, file tree, integrated multi-tab terminal, and maki ACP chat) for a project directory.",
    schema = {
      type = "object",
      properties = {
        path = {
          type = "string",
          description = "Workspace directory path to open (defaults to current working directory).",
        },
      },
    },
    handler = function(input)
      local ok, res = M.launch(input and input.path or nil)
      if not ok then
        return { llm_output = "error: " .. tostring(res), is_error = true }
      end
      return { llm_output = "Launched MorMaki IDE at " .. tostring(res) }
    end,
  })
end

return M
