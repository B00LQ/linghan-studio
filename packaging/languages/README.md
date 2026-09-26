# 安装向导的简体中文（Inno Setup 语言包）

`ChineseSimplified.isl` 不是 Inno Setup 自带的（官方只随包发布二十来种语言，中文不在其中）。
这份来自社区维护的翻译：

- 来源：<https://github.com/kira-96/Inno-Setup-Chinese-Simplified-Translation>
- 维护者：Zhenghan Yang (Kira)
- 适用：Inno Setup 6.5.0+（我们用的是 6.7.3）

放在仓库里而不是让每台构建机自己装：**打包要可复现** —— 别人 clone 下来跑
`node packaging/build-desktop.mjs` 就该能编译出同样的安装程序，而不是先去看一份
"请自行下载语言包" 的说明。

文件名与 [Inno Setup 官方翻译索引](https://jrsoftware.org/files/istrans/) 里的命名保持一致。
