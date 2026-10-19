// Learning guide, written for this app; terminology source: docs/zh-CN-terminology.json.
export const RULES = `
<section><h3><i class="ic ic-target"></i> 怎样获胜</h3>
<p>满足以下任意一项即可获胜：</p><ul>
<li>拿完自己的 <b>6 张奖赏卡</b>。对方宝可梦昏厥时，按其卡牌规则拿取奖赏卡。</li>
<li>对方场上没有宝可梦可以继续战斗。</li>
<li>对方回合开始需要抽牌时，牌库中没有卡牌。</li></ul>
<p>这是本游戏的学习说明。术语参考宝可梦简体中文官网；不代表本软件已通过官方规则认证。正式规则、例外和勘误请以官方说明及具体卡面为准。</p></section>
<section><h3><i class="ic ic-layers"></i> 三类卡牌</h3><ul>
<li><b>宝可梦卡</b>：基础宝可梦可以直接上场；1阶进化叠放在对应基础宝可梦上，2阶进化叠放在对应1阶进化上。</li>
<li><b>能量卡</b>：附在宝可梦身上，满足招式与撤退要求。★（无色）要求可用任意属性能量满足。</li>
<li><b>训练家卡</b>：帮助抽牌、恢复、寻找卡牌等，现代模式中包括物品卡、宝可梦道具、支援者卡、竞技场卡。</li></ul></section>
<section><h3><i class="ic ic-layers"></i> 看懂宝可梦卡</h3>
<div class="anatomy"><div class="card-wrap"><img src="img/zh-learning/base1-46.svg" alt="小火龙中文练习卡面示意，非官方扫描">
<span class="pin" style="left:5%;top:7.5%">1</span><span class="pin" style="left:14%;top:2.8%">2</span>
<span class="pin" style="left:68%;top:6%">3</span><span class="pin" style="left:95%;top:6%">4</span>
<span class="pin" style="left:6%;top:62%">5</span><span class="pin" style="left:40%;top:62%">6</span>
<span class="pin" style="left:94%;top:62%">7</span><span class="pin" style="left:10%;top:83%">8</span>
<span class="pin" style="left:50%;top:83%">9</span><span class="pin" style="left:88%;top:83%">10</span></div><ol>
<li><b>卡牌名</b>：用于识别宝可梦，进化时要与进化来源对应。</li>
<li><b>进化状态</b>：基础、1阶进化或2阶进化。</li>
<li><b>HP</b>：剩余 HP 小于等于 0 时，宝可梦昏厥。</li>
<li><b>属性</b>：用于判断弱点与抗性，不由附着的能量决定。</li>
<li><b>招式所需能量</b>：使用前需要满足左侧的能量符号。</li>
<li><b>招式名称与效果</b>：除了伤害，还可能有其他效果。</li>
<li><b>伤害</b>：通常对对方战斗宝可梦造成。</li>
<li><b>弱点</b>：受到指定属性宝可梦的招式伤害时，按卡面计算加成。</li>
<li><b>抗性</b>：受到指定属性宝可梦的招式伤害时，减少卡面所示数值。</li>
<li><b>撤退所需能量</b>：执行撤退时需要从自身放于弃牌区的能量。</li></ol></div>
<p>已取得并核对的中文原图保持原样；尚未取得原图的卡显示明确标注的中文练习卡面，不将其冒充官方扫描。</p></section>
<section><h3><i class="ic ic-flag"></i> 对战准备</h3>
<p>每人使用一套 <b>60 张卡</b>的卡组，洗牌后抽 <b>7 张</b>手牌。选 1 只基础宝可梦放到战斗场，还可放最多 5 只到备战区。再从牌库顶取 6 张作为反面朝上的奖赏卡。</p>
<p>起手没有基础宝可梦时，将手牌放回洗牌重抽，对方可按重抽次数额外抽牌。本游戏通过猜硬币安排先攻。</p></section>
<section><h3><i class="ic ic-repeat"></i> 一个回合怎么进行</h3><ol>
<li>回合开始，<b>抽 1 张牌</b>。</li>
<li>按需要安排以下操作：放基础宝可梦到备战区、进化、附着能量、使用训练家卡或特性、撤退。</li>
<li>最后<b>使用招式</b>，然后回合结束。不使用招式也可以直接结束回合。</li></ol>
<ul><li>通常每回合从手牌<b>附着 1 张能量卡</b>。</li>
<li>通常每回合<b>撤退 1 次</b>。卡牌效果造成的替换与撤退不是同一个操作。</li>
<li>双方各自的首回合不能进化；刚上场或刚进化的宝可梦通常不能在同回合再进化。</li>
<li>先攻玩家首回合不能使用招式，现代规则下也不能使用支援者卡。</li></ul></section>
<section><h3><i class="ic ic-repeat"></i> 一个练习例子</h3>
<p>你的 小火龙 附有 1 个火能量，且上回合已在场。这回合将它进化为 火恐龙，再附着 1 张火能量，共有 2 个能量。</p>
<p>示例卡的 劈开 需要 3 个无色能量，喷射火焰 需要 2 个火加 1 个无色能量，现在都不够。你可以结束回合，下回合补足能量后再使用招式。<b>使用招式通常不会消耗能量，只有卡牌效果另有要求时才丢弃。</b></p></section>
<section><h3><i class="ic ic-scale"></i> 经典与现代模式</h3>
<p>两种模式保留了 Academy 的既有规则实现，不应将经典模式视为完整的历史赛事规则还原。</p>
<table class="rules-compare"><thead><tr><th>项目</th><th class="c-classic">经典模式</th><th class="c-modern">现代模式</th></tr></thead><tbody>
<tr><th>训练家卡</th><td>每回合可使用多张训练家卡。</td><td>物品卡数量不限；支援者卡最多 1 张；竞技场卡最多使出 1 张；道具附在宝可梦身上。</td></tr>
<tr><th>先攻首回合</th><td>不能使用招式。</td><td>不能使用招式，也不能使用支援者卡。</td></tr>
<tr><th>特殊能力</th><td>经典能力（Pokémon Power），多数在睡眠、混乱或麻痹时失效。</td><td>特性（Ability），通常不会因上述状态失效。</td></tr>
<tr><th>奖赏卡</th><td>普通宝可梦通常提供 1 张。</td><td>以卡牌规则为准：ex、V、VSTAR、GX 通常为 2 张；VMAX、TAG TEAM、超级进化 ex 通常为 3 张。</td></tr>
<tr><th>道具</th><td>部分附着的训练家卡只持续有限回合。</td><td>宝可梦道具通常每只最多 1 张，并留在场上。</td></tr>
<tr><th>每局限制</th><td>以卡牌效果为准。</td><td>每位玩家每局只能使用 1 次 GX 招式和 1 次 VSTAR 力量。</td></tr>
</tbody></table></section>
<section><h3><i class="ic ic-swords"></i> 伤害与昏厥</h3>
<p>招式伤害要结合弱点、抗性及其他效果计算。<b>放置伤害指示物不等于造成招式伤害</b>，不要将两者混用。</p>
<p>每个“10”的伤害指示物表示 10 伤害。累计伤害达到 HP 时，宝可梦昏厥，连同附着的卡放于弃牌区，对方按规则拿取奖赏卡。若是战斗宝可梦昏厥，需从备战区选一只接替。</p></section>
<section><h3><i class="ic ic-sparkles"></i> 特殊状态与宝可梦检查</h3>
<p>回合结束后、下回合开始前进行<b>宝可梦检查</b>。特殊状态通常只影响战斗宝可梦，进化或回到备战区可以恢复。</p><ul>
<li><b>中毒</b>：每次检查放 1 个“10”的伤害指示物。</li>
<li><b>灼伤</b>：每次检查放 2 个“10”的伤害指示物，再抛掷硬币，正面则恢复。</li>
<li><b>睡眠</b>：不能使用招式或撤退；每次检查抛掷硬币，正面则恢复。</li>
<li><b>麻痹</b>：下个自己的回合不能使用招式或撤退，该回合结束后的检查时恢复。</li>
<li><b>混乱</b>：使用招式时抛掷硬币，反面则招式失败，并给自身放 3 个“10”的伤害指示物。</li></ul></section>
<section><h3><i class="ic ic-coins"></i> 硬币与骰子</h3>
<p><b>硬币</b>用于执行卡牌所述的随机效果，正面与反面各有一半机会。<b>骰子</b>在本游戏中用于记录伤害，不用于决定招式威力。点数骰子的 4 个点代表 40 伤害，不是 4 伤害。</p>
<div data-dice-chart></div></section>
<section><h3><i class="ic ic-book-open"></i> 常用术语</h3><dl class="glossary">
<dt>战斗场／战斗宝可梦</dt><dd>正在战斗的位置，以及处于这个位置的宝可梦。</dd>
<dt>备战区／备战宝可梦</dt><dd>通常最多 5 只，准备进化、附着能量或接替战斗。</dd>
<dt>卡组／牌库</dt><dd>卡组是构筑的整套卡；牌库是对战时用于抽牌的区域。</dd>
<dt>弃牌区</dt><dd>用过或被效果放于此处的卡牌所在区域。</dd>
<dt>物品卡／支援者卡</dt><dd>两类训练家卡，使用次数限制不同。</dd>
<dt>竞技场卡</dt><dd>留在场上影响双方，新使出的不同名竞技场卡会替换旧卡。</dd>
<dt>宝可梦道具</dt><dd>附在宝可梦身上，提供持续效果。</dd>
<dt>抗性</dt><dd>受到指定属性的招式伤害时，减少卡面所示数值。</dd>
<dt>宝可梦检查</dt><dd>两名玩家回合之间检查特殊状态及相关效果的阶段。</dd></dl></section>
<section><h3><i class="ic ic-package"></i> 选择卡组</h3>
<p>内置 <b>{classic} 套经典卡组</b>与 <b>{modern} 套现代卡组</b>。先选一套喜欢的卡组，熟悉抽牌、附着能量和使用招式，再尝试更多配合。</p></section>
<section><h3><i class="ic ic-brain"></i> 小茂与博士</h3>
<p>小茂是练习对手，博士为合法操作评分并给出建议。它们使用设置中选定的引擎。评分是学习参考，<b>不是规则裁定，也不保证获胜</b>。可以在对战记录中回看自己的选择。</p></section>`;
