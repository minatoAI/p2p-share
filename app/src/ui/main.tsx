import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

/**
 * 故意不包 StrictMode。
 *
 * StrictMode 在开发模式下会把 effect 跑两遍，而这里的 effect 会建
 * RTCPeerConnection、开 WebSocket、注册 paste 监听。跑两遍就会多出一条
 * 连接和一个监听器，排查起来很烦。Phase 1 先不加，等连接管理写成幂等的再加回来。
 */
const root = document.getElementById('root');
if (!root) throw new Error('找不到 #root');
createRoot(root).render(<App />);
