##### SCRIPT for ANOVA, assumptions, graphs
library(pgirmess)
library(car)
library(agricolae)
library(ggstatsplot)
library(ggplot2)
library(multcompView)
library(tidyverse)
library(ggthemes)

setwd("/Users/anna/Desktop/Mariann")


# load data
#my_data <-
#  read.table(file = "clipboard", sep = "\t", header = TRUE) # puts data from clipboard into a workspace table
# the above does not work anymore, use "Import Datasheet" in the Environment options

library(readxl)
my_data <- read_excel("_PE strain statistics data_complete_ANNA_Final04.xlsx", sheet="more params R")
#View(my_data)

my_data$Cultivation_wavelength <- factor(my_data$Cultivation_wavelength)

#summary(my_data)

########### ASSUMPTIONS ################
par(mfrow = c(2, 2))
# run aov
# assumptions need to first run ANOVA! and then be plotted from it's results) http://www.sthda.com/english/wiki/wiki.php?title=one-way-anova-test-in-r
model <- aov( NPQ_625 ~ Cultivation_wavelength, data = my_data)
# Summary of the analysis
summary(model)

# homogen. of var.
# homogeneity of variance across groups
# plot residuals vs. fitted values
plot(model, 1)
### Levene's test http://www.sthda.com/english/wiki/wiki.php?title=one-way-anova-test-in-r
leveneTest(NPQ_625 ~ Cultivation_wavelength, data = my_data)
# population variances are not equal if “Sig.” or p < 0.05

# normality
### Normality plot of residuals. In the plot below, the quantiles of the residuals are plotted against the quantiles of the normal distribution. A 45-degree PBS_PSIIerence line is also plotted. The normal probability plot of residuals is used to check the assumption that the residuals are normally distributed. It should approximately follow a straight line.
plot(model, 2)
### Shapiro-Wilk's test of normal disribution
# Extract the residuals
residuals <- residuals(object = model)
# Run Shapiro-Wilk test
shapiro.test(x = residuals)
# The closer the observed data set is to the expected normal distribution, 
# the higher the value of W, and vice versa. The Shapiro-Wilk test uses a 
# null hypothesis that assumes the data set is normally distributed. 
# If the p-value of the test is less than the significance level (usually 0.05),
# the null hypothesis is rejected, and it is concluded that the data set is 
# not normally distributed.

############# post hoc ########
#TukeyHSD(model)
#plot(TukeyHSD(model)) # the bars that don't cross the "dotted" line represent significantly different pairs. It can also be judged by the p value -> the lower the p, the bigger the difference. --> agricolae package can help to identify the letters of significance
levels=levels(my_data$Cultivation_wavelength)

par(las = 1)
par(mar = c(6, 4.1, 4.1, 4.1))
b <-
  boxplot(
    my_data$NPQ_625 ~ my_data$Cultivation_wavelength,
    main = "NPQ_625",
    xaxt = "n",
    ylab = "NPQ_625",
    xlab = "Cultivation_wavelength"
  )

#axis(side=1, at=levels, labels = FALSE) #add ticks, but does not give me the correct. number of ticks
text(x=1:length(levels), y = par("usr")[3], 
     labels = levels, xpd = NA, srt = 35, adj=0, pos=1) #add labels


# save the above plot
#png((file = "boxplot_NPQ_625.png"),
#    width = 150,
#    height = 150,
#    res = 300,
#    units = "mm"
#)
#par(las = 1)
#par(mar = c(4, 6, 2, 1))
#b <-
#  boxplot(
#    my_data$NPQ_625 ~ my_data$Cultivation_wavelength,
#    main = "NPQ_625",
#    xlab = "",
#    ylab = "NPQ_625"
#  )
#dev.off()
# Tukey in plot, differently after: https://rdrr.io/cran/agricolae/man/HSD.test.html
# Old version HSD.test()
df <- df.residual(model)
MSerror <- deviance(model) / df
p <-
  with(
    my_data,
    HSD.test(
      NPQ_625,
      Cultivation_wavelength,
      df,
      MSerror,
      group = TRUE,
      console = TRUE,
      main = "Study name"
    )
  )

# visualize plot
par(las = 2) # las specifies the orientation of axis labels horizontal/vertical
par(mar = c(4, 6, 2, 1)) # margins
plot(p, main = "NPQ_625")
title(ylab = "NPQ_625", line = 4) # specifies the position of axis label

dev.off()
# save plot as png
#png((file = "postHoc_NPQ_625.png"),
#    width = 150,
#    height = 150,
#    res = 300,
#    units = "mm"
#)
#par(las = 1)
#par(mar = c(4, 6, 1, 1))
#plot(p, main = "NPQ_625")
#title(ylab = "NPQ_625", line = 4)
#dev.off()
#

##### compact plot - option A ######
tukey <- TukeyHSD(model)

# compact letter display
cld <- multcompLetters4(model, tukey)

# table with factors and 3rd quantile (or SD in my case?)
dt <- my_data[c("Cultivation_wavelength", "NPQ_625")] %>%
  na.omit(dt) %>%
  group_by(Cultivation_wavelength) %>%
  summarise(w=mean(NPQ_625), sd = sd(NPQ_625)) %>%
  arrange(desc(w))

# extracting the compact letter display and adding to the Tk table
cld <- as.data.frame.list(cld$Cultivation_wavelength)
dt$cld <- cld$Letters

#arrange table in ascending order of cultivation wavelength
dt$Cultivation_wavelength <- as.numeric(as.character(dt$Cultivation_wavelength))
dt <- arrange(dt,Cultivation_wavelength)


my_data2 <- read_excel("_PE strain statistics data_complete_ANNA_Final04.xlsx", sheet="more params") 

unclass(my_data2)
my_data2 <- as.data.frame(unclass(my_data2))
data2_filtered <- my_data2 %>%
  group_by(Cultivation_wavelength) %>%
  filter(sum(!is.na(NPQ_625)) < 3) %>%
  ungroup() %>%
  select(Cultivation_wavelength, NPQ_625) %>%
  na.omit(dt) 


# plot
p <- ggplot(dt, aes(Cultivation_wavelength, w, colour=Cultivation_wavelength)) + 
  geom_point(size=2) +
  scale_x_continuous(limits = c(400, 700), breaks = seq(400, 700, by = 50)) +
  scale_colour_gradientn(colours=c( "darkorchid3","dodgerblue3", "green4", "green","yellow2", "orange2", "red", "red3", "red4"), guide = "none") +
  geom_errorbar(aes(ymin = w-sd, ymax=w+sd), width = 0.2) +
  labs(x = "Cultivation wavelength (nm)", y = "NPQ_625") +
  geom_text(aes(label = cld, y = w + sd), vjust = -0.5) +
  theme_bw()

p + geom_point(data = data2_filtered, aes(x = Cultivation_wavelength, y = NPQ_625), size = 2)

print(p)

ggsave("NPQ_625.png", plot = last_plot(), width = 4, height = 4, dpi = 300)

dev.off()

#deposit for unused arguments in the ggplot


#########################################################

##### compact plot - option B = NONPARAMETRIC ######
tukey <- TukeyHSD(model)

# compact letter display
## option B
cld <- c("a", "b", "b", "ab", "ab", "b", "b", "b")
names(cld) <- c("465", "495", "520", "555", "596", "633", "663", "687")

# table with factors and 3rd quantile (or SD in my case?)
dt <- my_data[c("Cultivation_wavelength", "NPQ_625")] %>%
  na.omit(dt) %>%
  group_by(Cultivation_wavelength) %>%
  summarise(w=mean(NPQ_625), sd = sd(NPQ_625)) %>%
  arrange(desc(w))


#arrange table in ascending order of cultivation wavelength
dt$Cultivation_wavelength <- as.numeric(as.character(dt$Cultivation_wavelength))
dt <- arrange(dt,Cultivation_wavelength)

## option B if letters are added manually from nonparametric
dt$cld <- cld

my_data2 <- read_excel("_PE strain statistics data_complete_ANNA_v02.xlsx", sheet="Most data R2")

unclass(my_data2)
my_data2 <- as.data.frame(unclass(my_data2))
data2_filtered <- my_data2 %>%
  group_by(Cultivation_wavelength) %>%
  filter(sum(!is.na(NPQ_625)) < 3) %>%
  ungroup() %>%
  select(Cultivation_wavelength, NPQ_625) %>%
  na.omit(dt) 


# plot
p <- ggplot(dt, aes(Cultivation_wavelength, w, colour=Cultivation_wavelength)) + 
  geom_point(size=2) +
  scale_x_continuous(limits = c(400, 700), breaks = seq(400, 700, by = 50)) +
  scale_colour_gradientn(colours=c( "darkorchid3","dodgerblue3", "green4", "green","yellow2", "orange2", "red", "red3", "red4"), guide = "none") +
  geom_errorbar(aes(ymin = w-sd, ymax=w+sd), width = 0.2) +
  labs(x = "Cultivation wavelength (nm)", y = "NPQ_625") +
  geom_text(aes(label = cld, y = w + sd), vjust = -0.5) +
  geom_smooth(method = lm, formula = y ~ splines::bs(x, 6), se = FALSE, col="BLACK", linewidth=0.25) +
  theme_bw()

p + geom_point(data = data2_filtered, aes(x = Cultivation_wavelength, y = NPQ_625), size = 2)

print(p)

ggsave("NPQ_625_NONparam.png", plot = last_plot(), width = 4, height = 4, dpi = 300)

dev.off()

#deposit for unused arguments in the ggplot


#########################################################




# ggplot with statistics on between group comparison
# trial. don't know how to add letters of significance.
library(ggsignif)
library(ggstatsplot)

ggbetweenstats(
  data = my_data,
  x = Cultivation_wavelength,
  y = NPQ_625,
  title = "title"
)+
  geom_signif(comparisons = list(c("G", "R", "B", "C", "K")))

#########################################################

##### BARPLOT summary ######

# load significance letters from xls (clipboard)
library(ggplot2)
library(tidyverse)
library(clipr)


CLIPR_ALLOW=TRUE
b2 <-
#  read.table(file = "clipboard", sep = "\t", header = TRUE) 
  read_clip_tbl(x = read_clip())

p <- ggplot(b2, aes(x=my_data$Cultivation_wavelength, y=, fill=component)) + 
  labs(title="NPQ_625")+
  geom_bar(stat="identity", position=position_dodge()) +
  geom_errorbar(aes(ymin=scores-SD, ymax=scores+SD), width=.2,
                position=position_dodge(.9))
 # geom_text(aes(y=scores, label=letters), vjust=1.6, 
 #           color="black", size=3.5)

 

p + geom_text(aes(label = letter), position = position_dodge(width = 0.9), vjust = -2.5) + theme_light() + scale_fill_brewer(palette="Paired")


######### NONPARAM #######
#### run alternative to ANOVA? <- based on assumptions
# Kruskal Wallis: no need for normal. dist., needs homog. var.
kruskal.test(my_data$NPQ_625 ~ my_data$Cultivation_wavelength)
# post hoc
t <- kruskalmc(my_data$NPQ_625 ~ my_data$Cultivation_wavelength)
t
## Welch one-way test Not assuming equal variances
oneway.test(NPQ_625 ~ Cultivation_wavelength, data = my_data)
# Pairwise t-tests with no assumption of equal variances
pairwise.t.test(
  my_data$NPQ_625,
  my_data$Cultivation_wavelength,
  p.adjust.method = "BH",
  pool.sd = FALSE
)


# The adjustment methods include the Bonferroni correction ("bonferroni") in which the p-values are multiplied by the number of comparisons. Less conservative corrections are also included by Holm (1979) ("holm"), Hochberg (1988) ("hochberg"), Hommel (1988) ("hommel"), Benjamini & Hochberg (1995) ("BH" or its alias "fdr"), and Benjamini & Yekutieli (2001) ("BY"), resPEctively. A pass-through option ("none") is also included. The set of methods are contained in the p.adjust.methods vector for the benefit of methods that need to have the method as an option and pass it on to p.adjust. 
# The first four methods are designed to give strong control of the family-wise error rate. There seems no reason to use the unmodified Bonferroni correction because it is dominated by Holm's method, which is also valid under arbitrary assumptions. 
# Hochberg's and Hommel's methods are valid when the hypothesis tests are indePEndent or when they are non-negatively associated (Sarkar, 1998; Sarkar and Chang, 1997). Hommel's method is more powerful than Hochberg's, but the difference is usually small and the Hochberg p-values are faster to compute.
# The "BH" (aka "fdr") and "BY" method of Benjamini, Hochberg, and Yekutieli control the false discovery rate, the exPEcted proportion of false discoveries amongst the rejected hypotheses. The false discovery rate is a less stringent condition than the family-wise error rate, so these methods are more powerful than the others.
# Note that you can set n larger than length(p) which means the unobserved p-values are assumed to be greater than all the observed p for "bonferroni" and "holm" methods and equal to 1 for the other methods. 


########### TWO-WAY ANOVA ########### 
# A two-way ANOVA (“analysis of variance”) is used to determine whether or not there is a statistically significant difference between the means of three or more indePEndent groups that have been split on two factors. ... Suppose we want to determine if exercise intensity and gender impact weight loss. In this case, the two factors we’re studying are exercise and gender and the response variable is weight loss, measured in pounds.(https://www.statology.org/two-way-anova-r/)

setwd("/Users/anna/Desktop/AT CH statistics")

data42 <- as.data.frame(AT_in_MC_DW_data)

#DIVIDE datset into individual time points
library(dplyr)
data0 <- filter(data,Day<1)
data11 <- filter(data,Day==11)
data21 <- filter(data,Day==21)
data42 <- filter(data,Day==42)
data57 <- filter(data,Day==57)

#GRAPH of groups' data distribution
#set margins so that axis labels on boxplot don't get cut off
par(mar=c(8, 4.1, 4.1, 2.1))

#create boxplots
boxplot(DW_GperL ~ Strain:Condition,
        data = data42,
        main = "All samples in MC, Distribution by Group (day 11)",
        xlab = "Group",
        ylab = "DW (g/L)",
        col = "azure3",
        border = "black", 
        las = 2 #make x-axis labels perpendicular
)

#ANOVA: fit the two-way ANOVA model
# Note that the * between the two predictor variables indicates that we also want to test for an interaction effect between the two predictor variables.
model <- aov(DW_GperL ~ Strain * Condition, data = data42)

#view the model output
summary(model)


#ASSUMPTIONS
#1. Independence – the observations in each group need to be independent of each other. Since we used a randomized design, this assumption should be met so we don’t need to worry too much about this.

#2. Normality – the dependent variable should be approximately normally distributed for each combination of the groups of the two factors.
#define model residuals
resid <- model$residuals
#create histogram of residuals
hist(resid, main = "Histogram of Residuals", xlab = "Residuals", col = "azure3")
#Q-Q Resuíduals
plot(model, 2)
### Shapiro-Wilk's test of normal disribution
shapiro.test(x = resid)

#3. Equal Variance – the variances for each group are equal or approximately equal.
leveneTest(DW_GperL ~ Strain * Condition, data = data42)

#POST HOC Tukey's test for multiple comparisons
TukeyHSD(model, conf.level=.95) 

#visualize the 95% confidence intervals that result from the Tukey Test
par(mar=c(4.1, 13, 4.1, 2.1))
#create confidence interval for each comparison
plot(TukeyHSD(model, conf.level=.95), las = 2)



# Close device
dev.off()

############## NONPARAMETRIC ############## 
#The Aligned Rank Transform (ART) procedure is a non-parametric method that can handle interactions in factorial designs. ART allows for the analysis of interaction effects and main effects in a way that is robust to the violations of ANOVA assumptions.
#Aligning: Subtract the overall effect of the other factors and interactions from each observation to focus on the effect of the target factor.
#Ranking: Rank the aligned observations.
#ANOVA on Ranks: perform an ANOVA on these ranks.
#https://www.geeksforgeeks.org/r-language/what-is-the-non-parametric-equivalent-of-a-two-way-anova-in-r/

library(ARTool)
data42$Strain <- as.factor(data42$Strain)
data42$Condition <- as.factor(data42$Condition)

# apply the ART procedure
art_model <- art(DW_GperL ~ Strain * Condition, data = data42)

# Conduct ANOVA on the ART model
# Main Effects: Look at the significance of each main effect to understand the individual influence of each factor on the dependent variable.
#Interaction Effects: A significant interaction effect indicates that the effect of one factor depends on the level of the other factor.
anova_art <- anova(art_model)

print(anova_art)

### post-hoc for ART - main efects ###
library(rcompanion)

marginal = art.con(art_model, "Strain")

marginal

Sum = as.data.frame(marginal)

cldList(p.value ~ contrast, data=Sum)

### post-hoc for ART - interactions ###
marginal = art.con(art_model, "Strain:Condition", adjust="none")

marginal

Sum = as.data.frame(marginal)

cldList(p.value ~ contrast, data=Sum)

