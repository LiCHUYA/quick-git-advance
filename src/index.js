const simpleGit = require("simple-git");
const { Octokit } = require("@octokit/rest");
const fs = require("fs").promises;
const path = require("path");
const inquirer = require("inquirer");
const fetch = require("node-fetch");
const { loadConfig, saveConfig } = require("./config");
const { ensureAuth } = require("./auth");
const GitUtils = require("./utils");
const chalk = require("chalk");

// 通用的 .gitignore 模板
const DEFAULT_GITIGNORE = `# Dependencies
/node_modules
/.pnp
.pnp.js

# Testing
/coverage

# Production
/build
/dist

# Misc
.DS_Store
.env.local
.env.development.local
.env.test.local
.env.production.local

# Logs
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Editor
.idea/
.vscode/
*.swp
*.swo

# OS generated files
.DS_Store
.DS_Store?
._*
.Spotlight-V100
.Trashes
ehthumbs.db
Thumbs.db`;

class GitInitializer {
  constructor() {
    this.git = simpleGit();
    this.utils = GitUtils;
    console.log("Debug: GitInitializer 初始化");
  }

  // 检查本地仓库冲突
  async checkLocalConflicts(repoName) {
    try {
      // 检查目标目录是否存在
      if (
        await fs.access(path.join(process.cwd(), repoName)).catch(() => false)
      ) {
        const { action } = await inquirer.prompt([
          {
            type: "list",
            name: "action",
            message: `目录 ${repoName} 已存在，请选择操作:`,
            choices: [
              { name: "在当前目录初始化", value: "current" },
              { name: "使用新目录", value: "new" },
              { name: "取消操作", value: "cancel" },
            ],
          },
        ]);

        if (action === "cancel") {
          throw new Error("用户取消操作");
        }

        if (action === "new") {
          const { newName } = await inquirer.prompt([
            {
              type: "input",
              name: "newName",
              message: "请输入新的目录名:",
              default: `${repoName}-new`,
              validate: (input) => input.length > 0 || "目录名不能为空",
            },
          ]);
          return newName;
        }
      }

      return repoName;
    } catch (error) {
      throw new Error(`检查本地冲突失败: ${error.message}`);
    }
  }

  // 修改初始化方法
  async initialize() {
    try {
      console.log("Debug: 开始初始化流程");

      // 首先检查当前目录是否已是 Git 仓库
      if (await this.utils.isGitRepository(process.cwd())) {
        this.utils.log.error("当前目录已存在 Git 仓库");
        return false;
      }

      // 先获取平台信息
      const basicInfo = await this.collectBasicInfo();
      console.log("Debug: 基本信息", basicInfo);

      // 检查本地冲突
      const finalRepoName = await this.checkLocalConflicts(basicInfo.repoName);
      if (finalRepoName !== basicInfo.repoName) {
        basicInfo.repoName = finalRepoName;
        console.log("Debug: 使用新的仓库名称:", finalRepoName);
      }

      // 检查远程仓库是否已存在
      try {
        const config = await this.ensurePlatformConfig(basicInfo.platform);
        await this.checkRemoteExists(
          basicInfo.platform,
          basicInfo.repoName,
          config
        );
      } catch (error) {
        if (error.message.includes("已存在")) {
          const { action } = await inquirer.prompt([
            {
              type: "list",
              name: "action",
              message: "远程仓库已存在，请选择操作:",
              choices: [
                { name: "使用新名称", value: "rename" },
                { name: "取消操作", value: "cancel" },
              ],
            },
          ]);

          if (action === "cancel") {
            throw new Error("用户取消操作");
          }

          const { newName } = await inquirer.prompt([
            {
              type: "input",
              name: "newName",
              message: "请输入新的仓库名称:",
              default: `${basicInfo.repoName}-new`,
              validate: (input) => input.length > 0 || "仓库名称不能为空",
            },
          ]);
          basicInfo.repoName = newName;
        } else {
          throw error;
        }
      }

      // 检查 SSH 配置
      const hasSshConfig = await this.utils.checkSshConfig(basicInfo.platform);
      if (!hasSshConfig) {
        console.log(
          chalk.yellow(`\n⚠️ ${basicInfo.platform} 的 SSH 配置可能有问题`)
        );
        console.log(
          chalk.blue(this.utils.getSshSetupGuide(basicInfo.platform))
        );

        const { continue: shouldContinue } = await inquirer.prompt([
          {
            type: "confirm",
            name: "continue",
            message: "是否继续?",
            default: false,
          },
        ]);

        if (!shouldContinue) {
          console.log(chalk.yellow("请配置 SSH 后重试"));
          return false;
        }
      }

      // 获取平台配置
      console.log("Debug: 获取平台配置");
      let config = await this.ensurePlatformConfig(basicInfo.platform);
      console.log("Debug: 平台配置获取成功");

      // 收集仓库信息
      console.log("Debug: 收集仓库信息");
      const repoInfo = await this.collectRepoInfo();
      console.log("Debug: 仓库信息", repoInfo);

      // 创建远程仓库
      console.log("Debug: 开始创建远程仓库");
      const repoSshUrl = await this.createRemoteRepo({
        ...basicInfo,
        ...repoInfo,
        config,
      });
      console.log("Debug: 远程仓库创建成功", repoSshUrl);

      // 初始化本地仓库
      console.log("Debug: 开始初始化本地仓库");
      await this.initializeLocalRepo(repoSshUrl, repoInfo);
      console.log("Debug: 本地仓库初始化完成");

      return true;
    } catch (error) {
      console.error("初始化失败:", error);
      return false;
    }
  }

  // 收集基本信息
  async collectBasicInfo() {
    return inquirer.prompt([
      {
        type: "input",
        name: "repoName",
        message: "仓库名称:",
        validate: (input) => input.length > 0 || "仓库名称不能为空",
      },
      {
        type: "list",
        name: "platform",
        message: "选择代码托管平台:",
        choices: [
          { name: "GitHub", value: "github" },
          { name: "Gitee", value: "gitee" },
        ],
      },
    ]);
  }

  // 确保平台配置
  async ensurePlatformConfig(platform) {
    return await ensureAuth(platform);
  }

  // 收集仓库信息
  async collectRepoInfo() {
    const config = await loadConfig();
    return inquirer.prompt([
      {
        type: "list",
        name: "visibility",
        message: "仓库可见性:",
        choices: [
          { name: "公开", value: "public" },
          { name: "私有", value: "private" },
        ],
      },
      {
        type: "input",
        name: "description",
        message: "仓库描述:",
        default: "Created by Quick Git Advance",
        validate: (input) => input.length <= 255 || "描述不能超过255个字符",
      },
      {
        type: "input",
        name: "mainBranch",
        message: "主分支名称:",
        default: config.defaultBranch || "master",
      },
      {
        type: "confirm",
        name: "needDevBranch",
        message: "是否需要创建独立的开发分支?",
        default: false,
      },
      {
        type: "input",
        name: "developBranch",
        message: "开发分支名称:",
        default: "master",
        when: (answers) => answers.needDevBranch,
      },
    ]);
  }

  // 创建远程仓库
  async createRemoteRepo(options) {
    const { platform } = options;
    const creators = {
      github: async (opts) => await this.createGitHubRepo(opts),
      gitee: async (opts) => await this.createGiteeRepo(opts),
    };

    if (!creators[platform]) {
      throw new Error(`不支持的平台: ${platform}`);
    }

    try {
      return await creators[platform](options);
    } catch (error) {
      // 如果是认证错误，清除配置并重试
      if (error.message.includes("401") || error.message.includes("认证失败")) {
        await this.clearPlatformConfig(platform);
        const newConfig = await this.ensurePlatformConfig(platform);
        return await creators[platform]({ ...options, config: newConfig });
      }
      throw error;
    }
  }

  // 创建 GitHub 仓库
  async createGitHubRepo(options) {
    const { repoName, visibility, description, config } = options;
    const octokit = new Octokit({ auth: config.token });

    try {
      const response = await octokit.repos.createForAuthenticatedUser({
        name: repoName,
        description,
        private: visibility === "private",
        auto_init: false,
      });

      return response.data.ssh_url;
    } catch (error) {
      throw new Error(`GitHub 仓库创建失败: ${error.message}`);
    }
  }

  // 创建 Gitee 仓库
  async createGiteeRepo(options) {
    const { repoName, visibility, description, config } = options;
    const api = "https://gitee.com/api/v5/user/repos";

    try {
      // 添加调试日志
      console.log("Debug: Gitee API 请求参数:", {
        name: repoName,
        private: visibility === "private",
        description,
        access_token: "***", // 隐藏实际token
      });

      const response = await fetch(api, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: repoName,
          description,
          private: visibility === "private",
          access_token: config.token,
          auto_init: false,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error("Debug: Gitee API 错误响应:", {
          status: response.status,
          data: errorData,
        });
        throw new Error(
          `HTTP error! status: ${response.status}, message: ${JSON.stringify(
            errorData
          )}`
        );
      }

      const data = await response.json();
      if (!data.ssh_url) {
        throw new Error("创建成功但未返回仓库地址");
      }
      return data.ssh_url;
    } catch (error) {
      if (error.message.includes("422")) {
        // 尝试获取详细错误信息
        throw new Error(
          `Gitee 仓库创建失败: 请检查仓库名称是否已存在或包含特殊字符`
        );
      }
      throw new Error(`Gitee 仓库创建失败: ${error.message}`);
    }
  }

  // 初始化本地仓库
  async initializeLocalRepo(repoSshUrl, repoInfo) {
    const { mainBranch, developBranch, needDevBranch } = repoInfo;

    try {
      // 创建并写入 .gitignore
      await this.createGitignore();

      // 初始化 Git 仓库
      await this.git.init();
      this.utils.log.success("Git 仓库初始化成功");

      // 只添加 .gitignore 文件
      await this.git.add(".gitignore");
      await this.git.commit("chore: add .gitignore");
      this.utils.log.success("创建初始提交");

      // 推送前测试 SSH 连接
      const platform = repoSshUrl.includes("github.com") ? "github" : "gitee";
      const testCmd = `ssh -T git@${platform}.com`;

      try {
        await this.git.raw(["remote", "add", "origin", repoSshUrl]);
        this.utils.log.success(`添加远程仓库 ${repoSshUrl}`);
      } catch (error) {
        // 如果失败，清理已创建的文件
        await this.cleanupOnFailure();
        throw error;
      }

      // 如果推送失败，提供帮助信息
      try {
        await this.git.push(["-u", "origin", mainBranch]);
      } catch (error) {
        // 如果失败，清理已创建的文件
        await this.cleanupOnFailure();
        if (error.message.includes("Permission denied (publickey)")) {
          console.log(chalk.red("\n❌ SSH 推送失败"));
          throw new Error("SSH 认证失败，请确保已正确配置 SSH 密钥");
        }
        throw error;
      }

      // 设置主分支
      await this.git.branch(["-M", mainBranch]);
      this.utils.log.success(`主分支名称为 ${mainBranch}`);

      // 只有当需要开发分支且开发分支名与主分支名不同时才创建开发分支
      if (needDevBranch && developBranch && developBranch !== mainBranch) {
        await this.git.checkoutLocalBranch(developBranch);
        this.utils.log.success(`创建并切换到 ${developBranch} 分支`);
        await this.git.push(["-u", "origin", developBranch]);
        this.utils.log.success("推送开发分支到远程仓库");
        await this.git.checkout(mainBranch);
        this.utils.log.success(`切回 ${mainBranch} 分支`);
      }
    } catch (error) {
      // 如果任何步骤失败，清理已创建的文件
      await this.cleanupOnFailure();
      throw error;
    }
  }

  // 添加清理方法
  async cleanupOnFailure() {
    try {
      // 删除 .git 目录
      await fs.rm(path.join(process.cwd(), ".git"), {
        recursive: true,
        force: true,
      });
      // 删除 .gitignore 文件
      await fs.unlink(path.join(process.cwd(), ".gitignore")).catch(() => {});
      this.utils.log.info("已清理临时文件");
    } catch (error) {
      this.utils.log.warning("清理临时文件失败");
    }
  }

  // 添加 createGitignore 方法
  async createGitignore() {
    try {
      await fs.writeFile(".gitignore", DEFAULT_GITIGNORE);
      this.utils.log.success("创建 .gitignore 文件");
    } catch (error) {
      throw new Error(`创建 .gitignore 失败: ${error.message}`);
    }
  }

  // 添加清除平台配置的方法
  async clearPlatformConfig(platform) {
    const config = await loadConfig();
    config.platforms[platform] = {
      username: "",
      token: "",
      defaultVisibility: "public",
      defaultLicense: "MIT",
    };
    await saveConfig(config);
    this.utils.log.warning(`已清除 ${platform} 的配置信息`);
  }

  // 检查远程仓库是否存在
  async checkRemoteExists(platform, repoName, config) {
    try {
      if (platform === "github") {
        const octokit = new Octokit({ auth: config.token });
        await octokit.repos.get({
          owner: config.username,
          repo: repoName,
        });
      } else if (platform === "gitee") {
        const response = await fetch(
          `https://gitee.com/api/v5/repos/${config.username}/${repoName}?access_token=${config.token}`
        );
        if (response.ok) {
          throw new Error("仓库已存在");
        }
      }
    } catch (error) {
      if (error.status === 404) {
        return false; // 仓库不存在
      }
      throw new Error(`仓库已存在`);
    }
  }
}

// 导出实例化的对象
module.exports = new GitInitializer().initialize.bind(new GitInitializer());
