// 实际注入页面的脚本
document.addEventListener("maozierp-msg-chore",
    function(event) {
        console.log("收到毛子ERP插件的数据请求:", event.detail);
        const {
            type
        } = event.detail;
        if (type === "GetWindowData") {
            try {
                // 检查当前网站
                const hostname = window.location.hostname;
                
                // 处理拼多多数据
                if (window.rawData && (hostname.includes('pinduoduo.com') || hostname.includes('yangkeduo.com'))) {
                    // 使用JSON序列化和反序列化来移除不可克隆的属性
                    const data = JSON.parse(JSON.stringify(window.rawData));
                    
                    // 发送数据回插件
                    window.postMessage({
                        type: "maozierp-msg-page",
                        data: data
                    }, "*");
                }
            } catch (error) {
                console.error("处理数据时出错:", error);
            }
        }
    });


