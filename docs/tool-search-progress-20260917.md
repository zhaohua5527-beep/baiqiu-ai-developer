# 搜索停顿与完成事件修复（2026-09-17）

## 已实现行为

修复位于 services/baiqiu_tool_execution.py，由现有 baiqiu_acp_entry.py 安装，hermes-acp-client.js 随启动复制该模块到兼容目录。没有改动安装运行时原文件、客户密钥、会话历史或取消策略。

- 搜索超时不再进入零匹配补查。保留部分结果和 search_timeout，并向模型和界面明确报告搜索未完成；不再建议用 offset 翻页重做超时查询。
- 没有 rg 的本地目录搜索优先使用系统已有 Git 的 grep，支持扩展正则，并遵循标准忽略规则。显式指定被忽略子目录仍可搜索。没有 Git、远程环境或指定 file_glob 时保留 grep 后备路径，改用扩展正则和逐行输出。
- Windows 本地 rg 收到原生可识别路径，避免把 /c/... 直接交给关闭了 MSYS 路径转换的原生程序。该变更覆盖内容搜索、文件名搜索及零匹配探测；不改变远程环境的路径语义。
- 并发工具在各自结束后由执行主线程处理、保存并发布完成事件，不再等待整批结束。模型侧仍等整批结束后推进，工具结果按原调用次序排列，依赖和副作用的执行屏障不变。
- ACP开始和完成通过真实 tool_call_id 关联到同一界面事件；同名工具乱序完成不会按名称FIFO错配。已公开的完成事件从旧队列移除，后续 step 回调不会重复发布。
- 保存失败不发布成功事件；中断和超时保留已完成结果，晚到工作线程不会重新覆盖终态。顺序工具也在保存后立即发布完成。
- 共享请求指令提示先定位路径再搜索；搜索超时不是“没有匹配”，避免同范围递归 grep 重复扫描。工具权限、推理等级、交叉回复协议保持原有行为。

## 实测及归因边界

原请求的约64秒工具等待、search_timeout及后续约120秒递归grep，见客户端工作目录 request-stall-20260917/诊断结论.md。

这次使用真实 Hermes LocalEnvironment 和 ShellFileOperations，未发送模型请求。分别采用当前测试进程PATH，以及注册表中普通Windows用户/系统PATH进行隔离对照。后者没有rg，会走备用搜索。

同一表达式 stream-segment-process|stream-segment-structured：

| 场景 | 原行为/问题 | 修复后的观察 |
| --- | --- | --- |
| 无rg，renderer-v2目录 | 普通grep将竖线当普通字符，返回0匹配 | 约0.80秒返回13处（仅扩展正则修复阶段） |
| 无rg，source-current根目录 | 全量grep包含依赖/构建目录；测试设置4秒预算仍返回search_timeout | 加入Git后备后约1.09秒返回38处 |
| 有rg，Windows中文绝对路径 | 原生rg收到/c/...，报路径不存在 | 根目录约0.75秒返回38处 |

以上是指定目录、指定表达式的单次隔离实测，不是模型首字速度保证。历史运行进程的原始PATH未直接读取，不能仅靠本次环境对照断言它必然使用了哪一个后端；但两条搜索后端的缺陷均已真实复现并修复。Git遵循忽略规则，这是根目录查询提速的重要原因。用户明确搜索忽略目录仍可获得结果。

图1尚未唯一关联请求，未宣告解决。当前仍没有证据把图1的等待与本次工具搜索缺陷等同。

## 验证

共43项相关测试通过：

- test/test_tool_execution_progress.py：13项，包含真实文件搜索（中文空格路径、正则或、忽略目录、显式搜索、files/count模式）、同名快慢任务乱序完成、先持久化后发布、SQLite关闭重开恢复、取消、超时、晚到线程、保存失败、顺序执行和重复安装。
- test/test_tool_generation_bridge.py：16项，原有供应商身份、推理协议、事件与诊断边界回归。
- 5个JavaScript测试文件共14项：hermes-acp-client-timeout、hermes-acp-mcp-bridge、cancel-output-persistence、cancel-output-dom、stage-result-retention-dom。包含启动复制新模块的验收。
- 使用隔离HERMES_HOME启动真实 baiqiu_acp_entry，通过ACP initialize握手，Hermes 0.20.0正常返回，无兼容失败或Python异常，退出码0。未调用模型。
- JavaScript语法及改动差异空白检查通过。

## 兼容与生效

兼容层复用Hermes现有执行器的结果处理、工具预算、持久化和取消实现，仅移动完成处理时点并增加调用ID。安装前对源代码锚点进行验证，全部编译完成后再替换模块函数；安装重复调用幂等。未来上游结构变化时记录兼容错误并保留原生执行，避免因补丁不兼容导致所有供应商无法使用。已验证的运行时为当前Hermes 0.20.0。

本轮代码目标为桌面“白球AI-测试-11”，实际加载源码目录 source-current，版本仍为3.0.25。本轮没有发布客户更新或更改版本号。

已同步测试用户数据下的 hermes-python-compat、hermes-foreground-python-compat、hermes-health-python-compat 启动文件。现有Python进程不会热替换已导入函数：本轮检查时桌面还有活动任务，因此没有强行关闭或重启。任务结束后退出并重新打开“白球AI-测试-11”，新进程才会应用本次修复。不可将文件已同步描述为当前活动任务已加载。

回滚备份位于 C:/Users/Lenovo/Desktop/白球AI-客户端/work/request-stall-20260917/before。回滚本次代码可恢复其中三个服务文件，移除新增兼容模块；测试兼容目录按对应备份恢复，在空闲时重启。仓库已有其他未提交修改，勿用全仓库重置。
