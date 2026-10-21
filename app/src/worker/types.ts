/** 灯塔的全部绑定。注意这里没有对象存储，也不需要。 */
export interface Env {
  /** 单例在线状态板，按设备号寻址。配对之后的一切信令都走它 */
  PRESENCE: DurableObjectNamespace;
  /** 单例，只负责分享注册表，存元信息不存字节 */
  REGISTRY: DurableObjectNamespace;
}
